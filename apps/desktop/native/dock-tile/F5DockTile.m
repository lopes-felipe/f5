// Shows the app icon chosen in F5's settings on its Dock tile while F5 is not running.
//
// The Dock loads this bundle from F5.app/Contents/PlugIns because the app's Info.plist
// names it under NSDockTilePlugIn. It stays loaded while F5 is in the Dock, so it also
// follows later changes. A running F5 draws its own Dock icon and this view is not shown.
//
// The app tells it the choice in two steps (apps/desktop/src/appIcon.ts): it writes the
// id under F5AppIcon in its own preferences, then posts "<bundle id>.app-icon-changed".

#import <AppKit/AppKit.h>

static NSString *const F5ChoiceKey = @"F5AppIcon";
static NSString *const F5ChangedSuffix = @".app-icon-changed";

/// The identifier of the app this plug-in ships in:
/// <App>.app/Contents/PlugIns/F5DockTile.docktileplugin.
static NSString *EnclosingAppIdentifier(NSBundle *plugIn) {
  NSURL *app = plugIn.bundleURL;
  for (int level = 0; level < 3; level++) app = app.URLByDeletingLastPathComponent;
  return [NSBundle bundleWithURL:app].bundleIdentifier;
}

/// The bundled image for a choice. Nil for the default icon, which has no file here, and
/// for an unknown id or a value that is not an id at all.
static NSImage *ImageForChoice(id choice, NSBundle *plugIn) {
  if (![choice isKindOfClass:[NSString class]]) return nil;
  NSString *name = choice;
  // Ids are short lowercase words. Anything else must not reach the file lookup.
  NSCharacterSet *notLowercase = [[NSCharacterSet
      characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz"] invertedSet];
  if (name.length == 0 || name.length > 32 ||
      [name rangeOfCharacterFromSet:notLowercase].location != NSNotFound)
    return nil;
  NSString *path = [plugIn pathForResource:name ofType:@"png"];
  return path ? [[NSImage alloc] initWithContentsOfFile:path] : nil;
}

@interface F5DockTile : NSObject <NSDockTilePlugIn>
@end

@implementation F5DockTile {
  NSDockTile *_tile;
  NSString *_appId;
}

- (void)setDockTile:(NSDockTile *)dockTile {
  NSDistributedNotificationCenter *center = [NSDistributedNotificationCenter defaultCenter];
  [center removeObserver:self];
  _tile = dockTile;
  // The Dock passes nil when F5 leaves it.
  if (!dockTile) return;
  _appId = EnclosingAppIdentifier([NSBundle bundleForClass:[self class]]);
  if (!_appId) return;
  [center addObserver:self
             selector:@selector(choiceChanged:)
                 name:[_appId stringByAppendingString:F5ChangedSuffix]
               object:nil
   suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [self refresh];
}

- (void)choiceChanged:(NSNotification *)notification {
  if ([NSThread isMainThread]) {
    [self refresh];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self refresh];
    });
  }
}

- (void)refresh {
  NSDockTile *tile = _tile;
  if (!tile || !_appId) return;
  CFStringRef domain = (__bridge CFStringRef)_appId;
  // Drop this process's cached copy, or a change made by the app would be missed.
  CFPreferencesAppSynchronize(domain);
  id choice = CFBridgingRelease(CFPreferencesCopyAppValue((__bridge CFStringRef)F5ChoiceKey, domain));
  NSImage *image = ImageForChoice(choice, [NSBundle bundleForClass:[self class]]);
  if (image) {
    NSSize size = tile.size;
    NSImageView *view =
        [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
    view.imageScaling = NSImageScaleProportionallyUpOrDown;
    view.image = image;
    tile.contentView = view;
  } else {
    // No content view: the Dock draws the icon built into the app.
    tile.contentView = nil;
  }
  [tile display];
}

@end
