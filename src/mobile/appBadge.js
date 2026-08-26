/* The red dot on the home screen icon.

   iOS 16.4 and later can put a count on the icon of a web app the user has
   added to their home screen, through the same Badging API desktop Chrome
   uses. Three conditions have to hold, and all three fail silently, so this
   module reports which one is missing rather than leaving a toggle that
   appears to do nothing:

     · The app has to have been added to the home screen. The API is not
       exposed to Safari tabs, to other iOS browsers, or to WKWebView.
     · Notification permission has to be granted. setAppBadge() succeeds
       without it and the count is remembered, but nothing is drawn until
       permission is given — at which point the badge appears with the count
       already correct.
     · It has to be called while the app is running, or from a service worker
       handling a push. iOS has no periodic background sync, so the count is
       written whenever the app is open and then holds that value until the
       next time it opens. Filing transactions on the desktop site leaves the
       phone's badge stale until the phone app is next opened — a limit of the
       platform, not of this code.

   See https://webkit.org/blog/14112/badging-for-home-screen-web-apps/ */

const PERMISSION_UNAVAILABLE = 'unavailable';

/** Does this browser expose the Badging API at all? */
export function badgeSupported() {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

/** Is this running as an installed app rather than a browser tab? */
export function isHomeScreenApp() {
  if (typeof window === 'undefined') return false;
  // navigator.standalone is the iOS-only original; display-mode covers
  // everyone else, including a desktop PWA install.
  return window.navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** 'granted' | 'denied' | 'default' | 'unavailable'. */
export function notificationPermission() {
  if (typeof Notification === 'undefined') return PERMISSION_UNAVAILABLE;
  return Notification.permission || 'default';
}

/**
 * Why the badge can't be switched on, or null if it can.
 *
 * Returned as a reason rather than a boolean because every one of these needs
 * a different sentence in front of the user: "add it to your home screen" and
 * "you said no to notifications" are not the same problem.
 */
export function badgeBlocker() {
  if (!badgeSupported()) return 'unsupported';
  if (!isHomeScreenApp()) return 'not-installed';
  const perm = notificationPermission();
  if (perm === PERMISSION_UNAVAILABLE) return 'unsupported';
  if (perm === 'denied') return 'denied';
  return null;
}

/**
 * Ask for the permission the badge is drawn under.
 *
 * Must be called from a user gesture — iOS ignores an unprompted request — so
 * this hangs off a toggle rather than running on load.
 */
export async function requestBadgePermission() {
  if (typeof Notification === 'undefined') return PERMISSION_UNAVAILABLE;
  try {
    return await Notification.requestPermission();
  } catch {
    // Older signatures take a callback and throw on the promise form.
    return notificationPermission();
  }
}

/**
 * Write the count onto the icon. Zero clears it rather than drawing a nought.
 *
 * Every failure here is cosmetic — a badge that doesn't appear must never take
 * the screen down with it — so the whole thing is swallowed.
 */
export function applyBadge(count) {
  if (!badgeSupported()) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  try {
    const done = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
    // Promise-returning in every implementation, but a rejection here is not
    // worth an unhandled rejection in the console.
    if (done && typeof done.catch === 'function') done.catch(() => {});
  } catch {
    /* not installed, permission withdrawn, or no support — nothing to do */
  }
}

/** Take the badge off the icon. */
export function clearBadge() {
  applyBadge(0);
}
