// Shows the app icon chosen in F5's settings on its Dock tile while F5 is not running.
//
// The Dock loads this bundle from F5.app/Contents/PlugIns because the app's Info.plist
// names it under NSDockTilePlugIn. It stays loaded while F5 is in the Dock, so it also
// follows later changes. A running F5 draws its own Dock icon and this view is not shown.
//
// The app tells it the choice in two steps (apps/desktop/src/appIcon.ts): it writes the
// id under F5AppIcon in its own preferences, then posts "<bundle id>.app-icon-changed"
// with the same id under "id" in the notification's userInfo. Nothing orders the write
// (through cfprefsd) before the notification (through distnoted), so the plug-in shows the
// id the notification carries, then reads the preference again a moment later. The app
// also posts once more when it quits, the moment this tile starts being shown.

#import <AppKit/AppKit.h>

static NSString *const F5ChoiceKey = @"F5AppIcon";
static NSString *const F5ChangedSuffix = @".app-icon-changed";
static NSString *const F5ChoiceUserInfoKey = @"id";
/// The characters an id may use. Anything else, "/" and "." included, never reaches the
/// file lookup. scripts/build-dock-tile.test.ts checks every id against this list.
static NSString *const F5ChoiceCharacters = @"abcdefghijklmnopqrstuvwxyz0123456789-";
static const NSUInteger F5ChoiceMaxLength = 32;
/// How long after a notification the stored preference is read again.
static const double F5RereadDelaySeconds = 1.0;

/// The identifier of the app this plug-in ships in:
/// <App>.app/Contents/PlugIns/F5DockTile.docktileplugin.
static NSString *EnclosingAppIdentifier(NSBundle *plugIn) {
  NSURL *app = plugIn.bundleURL;
  for (int level = 0; level < 3; level++) app = app.URLByDeletingLastPathComponent;
  return [NSBundle bundleWithURL:app].bundleIdentifier;
}

/// The bundled image's path for a choice. Nil for the default icon, which has no file here,
/// and for an unknown id or a value that is not an id at all.
static NSString *ImagePathForChoice(id choice, NSBundle *plugIn) {
  if (![choice isKindOfClass:[NSString class]]) return nil;
  NSString *name = choice;
  NSCharacterSet *disallowed =
      [[NSCharacterSet characterSetWithCharactersInString:F5ChoiceCharacters] invertedSet];
  if (name.length == 0 || name.length > F5ChoiceMaxLength ||
      [name rangeOfCharacterFromSet:disallowed].location != NSNotFound)
    return nil;
  return [plugIn pathForResource:name ofType:@"png"];
}

@interface F5DockTile : NSObject <NSDockTilePlugIn>
@end

@implementation F5DockTile {
  NSDockTile *_tile;
  NSString *_appId;
  /// The choice on the tile: an id with an image, or nil for the built-in icon.
  NSString *_shown;
  BOOL _hasShown;
  /// Counts notifications, so only the latest one's delayed re-read runs.
  NSUInteger _generation;
}

- (void)setDockTile:(NSDockTile *)dockTile {
  NSDistributedNotificationCenter *center = [NSDistributedNotificationCenter defaultCenter];
  [center removeObserver:self];
  _tile = dockTile;
  _hasShown = NO;
  _generation++;
  // The Dock passes nil when F5 leaves it.
  if (!dockTile) return;
  _appId = EnclosingAppIdentifier([NSBundle bundleForClass:[self class]]);
  if (!_appId) return;
  [center addObserver:self
             selector:@selector(choiceChanged:)
                 name:[_appId stringByAppendingString:F5ChangedSuffix]
               object:nil
   suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [self showChoice:[self storedChoice]];
}

- (void)choiceChanged:(NSNotification *)notification {
  id announced = notification.userInfo[F5ChoiceUserInfoKey];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self showChoice:announced ?: [self storedChoice]];
    NSUInteger generation = ++self->_generation;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(F5RereadDelaySeconds * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                     if (generation == self->_generation) [self showChoice:[self storedChoice]];
                   });
  });
}

/// The choice in the app's preferences, read fresh.
- (id)storedChoice {
  if (!_appId) return nil;
  CFStringRef domain = (__bridge CFStringRef)_appId;
  // Drop this process's cached copy, or a change made by the app would be missed.
  CFPreferencesAppSynchronize(domain);
  return CFBridgingRelease(CFPreferencesCopyAppValue((__bridge CFStringRef)F5ChoiceKey, domain));
}

- (void)showChoice:(id)choice {
  NSDockTile *tile = _tile;
  if (!tile) return;
  NSString *path = ImagePathForChoice(choice, [NSBundle bundleForClass:[self class]]);
  NSImage *image = path ? [[NSImage alloc] initWithContentsOfFile:path] : nil;
  NSString *shown = image ? choice : nil;
  // Any process of this user can post the notification: redraw only for a real change.
  if (_hasShown && (shown == _shown || [shown isEqualToString:_shown])) return;
  _hasShown = YES;
  _shown = shown;
  if (image) {
    NSSize size = tile.size;
    NSImageView *view =
        [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
    view.imageScaling = NSImageScaleProportionallyUpOrDown;
    view.image = image;
    view.identifier = shown;
    tile.contentView = view;
  } else {
    // No content view: the Dock draws the icon built into the app.
    tile.contentView = nil;
  }
  [tile display];
}

@end
