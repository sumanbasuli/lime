export const UPDATE_NOTICE_ENABLED_STORAGE_KEY = "lime.updateNotice.enabled";
export const UPDATE_NOTICE_PREFERENCE_EVENT = "lime:update-notice-preference";

export function readUpdateNoticeEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(UPDATE_NOTICE_ENABLED_STORAGE_KEY) !== "false";
}

export function writeUpdateNoticeEnabled(enabled: boolean) {
  window.localStorage.setItem(UPDATE_NOTICE_ENABLED_STORAGE_KEY, String(enabled));
  window.dispatchEvent(
    new CustomEvent<boolean>(UPDATE_NOTICE_PREFERENCE_EVENT, { detail: enabled })
  );
}
