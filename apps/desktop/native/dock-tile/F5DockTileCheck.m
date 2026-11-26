// Plays the Dock for scripts/build-dock-tile.ts --check: loads the built plug-in from a
// stand-in app bundle and checks that it follows the app's F5AppIcon preference.
//
//   F5DockTileCheck <stand-in .app> <choice with an image>
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

static BOOL showsImage(FakeTile *tile) {
  return [tile.contentView isKindOfClass:[NSImageView class]] &&
         ((NSImageView *)tile.contentView).image.isValid;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: F5DockTileCheck <app> <choice>\n");
      return 2;
    }
    NSString *appPath = @(argv[1]);
    NSString *choice = @(argv[2]);
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

    @try {
      setChoice(domain, choice);
      [instance setDockTile:dockTile];
      expect(showsImage(tile), @"a stored choice shows its image when the tile is attached");
      expect(NSEqualSizes(tile.contentView.frame.size, tile.size), @"the image fills the tile");
      expect(tile.displays == 1, @"the tile is redrawn once");

      // The app changes the choice while the plug-in stays loaded.
      NSString *changed = [domain stringByAppendingString:@".app-icon-changed"];
      NSDistributedNotificationCenter *center = [NSDistributedNotificationCenter defaultCenter];
      setChoice(domain, @"lines");
      [center postNotificationName:changed object:nil userInfo:nil deliverImmediately:YES];
      expect(waitFor(^{
               return (BOOL)(tile.contentView == nil);
             }),
             @"the default choice clears the tile after the change notification");

      setChoice(domain, choice);
      [center postNotificationName:changed object:nil userInfo:nil deliverImmediately:YES];
      expect(waitFor(^{
               return showsImage(tile);
             }),
             @"a later choice shows its image after the change notification");

      for (id bad in @[ @"retired", @"../Info", @"", @42 ]) {
        setChoice(domain, bad);
        [instance setDockTile:dockTile];
        expect(tile.contentView == nil, [NSString stringWithFormat:@"'%@' clears the tile", bad]);
      }

      setChoice(domain, nil);
      [instance setDockTile:dockTile];
      expect(tile.contentView == nil, @"no stored choice clears the tile");

      // Detached: later notifications must not touch the old tile.
      setChoice(domain, choice);
      [instance setDockTile:nil];
      int displays = tile.displays;
      [center postNotificationName:changed object:nil userInfo:nil deliverImmediately:YES];
      waitFor(^{
        return (BOOL)(tile.displays != displays);
      });
      expect(tile.displays == displays, @"a detached plug-in stops following changes");
    } @finally {
      setChoice(domain, nil);
    }
  }
  if (failures == 0) printf("Dock tile plug-in check passed\n");
  return failures == 0 ? 0 : 1;
}
