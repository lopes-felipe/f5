// Plays the Dock for scripts/build-dock-tile.ts --check: loads the built plug-in from a
// stand-in app bundle and checks that it follows the app's F5AppIcon preference.
//
//   F5DockTileCheck <stand-in .app> <choice with an image> <another choice with an image>
//
// It writes that preference in the stand-in app's own domain and removes it again.

#import <AppKit/AppKit.h>

/// What the plug-in needs from a Dock tile, without a Dock.
@interface FakeTile : NSObject
@property(strong) NSView *contentView;
@property NSSize size;
@property int displays;
- (void)display;
@end

@implementation FakeTile
- (void)display {
  self.displays++;
}
@end

static int failures = 0;

static void expect(BOOL condition, NSString *what) {
  if (condition) return;
  failures++;
  fprintf(stderr, "FAILED: %s\n", what.UTF8String);
}

static void setChoice(NSString *domain, id value) {
  CFPreferencesSetAppValue(CFSTR("F5AppIcon"), (__bridge CFPropertyListRef)value,
                           (__bridge CFStringRef)domain);
  CFPreferencesAppSynchronize((__bridge CFStringRef)domain);
}

/// Runs the main run loop until the condition holds or five seconds pass.
static BOOL waitFor(BOOL (^condition)(void)) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
  while (!condition() && [deadline timeIntervalSinceNow] > 0)
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  return condition();
}

/// The choice the tile shows: the plug-in names its image view after it. Nil for none.
static NSString *shownChoice(FakeTile *tile) {
  if (![tile.contentView isKindOfClass:[NSImageView class]]) return nil;
  NSImageView *view = (NSImageView *)tile.contentView;
  return view.image.isValid ? view.identifier : nil;
}

/// Lets the main run loop run for a while, to give a wrong redraw the chance to happen.
static void settle(double seconds) {
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4) {
      fprintf(stderr, "usage: F5DockTileCheck <app> <choice> <other choice>\n");
      return 2;
    }
    NSString *appPath = @(argv[1]);
    NSString *choice = @(argv[2]);
    NSString *other = @(argv[3]);
    NSBundle *app = [NSBundle bundleWithPath:appPath];
    NSString *domain = app.bundleIdentifier;
    NSString *plugInName = [app objectForInfoDictionaryKey:@"NSDockTilePlugIn"];
    NSBundle *plugIn = [NSBundle
        bundleWithPath:[app.builtInPlugInsPath stringByAppendingPathComponent:plugInName ?: @""]];
    NSError *error = nil;
    if (!domain || !plugIn || ![plugIn loadAndReturnError:&error]) {
      fprintf(stderr, "FAILED: the plug-in does not load: %s\n",
              error.localizedDescription.UTF8String ?: "no bundle");
      return 1;
    }
    Class principal = plugIn.principalClass;
    expect([principal conformsToProtocol:@protocol(NSDockTilePlugIn)],
           @"the principal class implements NSDockTilePlugIn");
    id<NSDockTilePlugIn> instance = [[principal alloc] init];
    FakeTile *tile = [[FakeTile alloc] init];
    tile.size = NSMakeSize(128, 128);
    NSDockTile *dockTile = (NSDockTile *)tile;
    NSString *changed = [domain stringByAppendingString:@".app-icon-changed"];
    NSDistributedNotificationCenter *center = [NSDistributedNotificationCenter defaultCenter];
    void (^announce)(NSString *) = ^(NSString *announced) {
      [center postNotificationName:changed
                            object:nil
                          userInfo:announced ? @{@"id" : announced} : nil
                deliverImmediately:YES];
    };

    @try {
      setChoice(domain, choice);
      [instance setDockTile:dockTile];
      expect([shownChoice(tile) isEqualToString:choice],
             @"a stored choice shows its image when the tile is attached");
      expect(NSEqualSizes(tile.contentView.frame.size, tile.size), @"the image fills the tile");
      expect(tile.displays == 1, @"the tile is redrawn once");

      // The app writes the preference, then announces the change with the id.
      setChoice(domain, @"lines");
      announce(@"lines");
      expect(waitFor(^{
               return (BOOL)(tile.contentView == nil);
             }),
             @"the default choice clears the tile after the change notification");

      // The notification arrives before the preference write: the announced id wins now,
      // and the stored value, read again a moment later, agrees with it.
      announce(other);
      expect(waitFor(^{
               return [shownChoice(tile) isEqualToString:other];
             }),
             @"the announced id shows before the preference catches up");
      setChoice(domain, other);
      settle(1.5);
      expect([shownChoice(tile) isEqualToString:other], @"the stored value keeps the announced id");

      // A notification without an id, from an older app: the preference changes only after
      // it, and the delayed re-read picks the change up.
      announce(nil);
      settle(0.3);
      setChoice(domain, choice);
      expect(waitFor(^{
               return [shownChoice(tile) isEqualToString:choice];
             }),
             @"a preference written after the notification is picked up by the re-read");

      // Repeating the current choice redraws nothing.
      int displays = tile.displays;
      announce(choice);
      settle(1.5);
      expect(tile.displays == displays, @"an unchanged choice is not redrawn");

      for (id bad in @[ @"retired", @"../Info", @"", @42 ]) {
        setChoice(domain, bad);
        [instance setDockTile:dockTile];
        expect(tile.contentView == nil, [NSString stringWithFormat:@"'%@' clears the tile", bad]);
        announce(choice);
        expect(waitFor(^{
                 return [shownChoice(tile) isEqualToString:choice];
               }),
               @"the announced id shows over a bad stored value");
        settle(1.5);
        expect(tile.contentView == nil,
               [NSString stringWithFormat:@"the stored '%@' wins after the re-read", bad]);
      }

      setChoice(domain, nil);
      [instance setDockTile:dockTile];
      expect(tile.contentView == nil, @"no stored choice clears the tile");

      // Detached: later notifications and pending re-reads must not touch the old tile.
      setChoice(domain, choice);
      announce(choice);
      [instance setDockTile:nil];
      displays = tile.displays;
      announce(other);
      settle(1.5);
      expect(tile.displays == displays, @"a detached plug-in stops following changes");
    } @finally {
      setChoice(domain, nil);
    }
  }
  if (failures == 0) printf("Dock tile plug-in check passed\n");
  return failures == 0 ? 0 : 1;
}
