export const VIDEO_ICONS = {
  play: '/assets/icons/material-icon-theme/video-play.svg',
  pause: '/assets/icons/material-icon-theme/video-pause.svg',
  volume: '/assets/icons/material-icon-theme/video-volume.svg',
  volumeLow: '/assets/icons/material-icon-theme/video-volume-low.svg',
  volumeMuted: '/assets/icons/material-icon-theme/video-volume-muted.svg',
  fullscreen: '/assets/icons/material-icon-theme/video-fullscreen.svg',
  fullscreenExit: '/assets/icons/material-icon-theme/video-fullscreen-exit.svg',
  pipEnter: '/assets/icons/material-icon-theme/video-pip-enter.svg',
  pipExit: '/assets/icons/material-icon-theme/video-pip-exit.svg',
  loop: '/assets/icons/material-icon-theme/music-loop.svg',
  previous: '/assets/icons/material-icon-theme/shared-prev.svg',
  next: '/assets/icons/material-icon-theme/shared-next.svg',
  back15: '/assets/icons/material-icon-theme/video-back-15.svg',
  forward15: '/assets/icons/material-icon-theme/video-forward-15.svg',
};
export const CONTROLS_IDLE_HIDE_MS = 2800;
export const COMPATIBILITY_SESSION_STATUS_POLL_MS = 1000;
export const COMPATIBILITY_PROGRESS_REPORT_BURST_MS = 1000;
export const COMPATIBILITY_PROGRESS_REPORT_STEADY_MS = 5000;
export const COMPATIBILITY_PROGRESS_REPORT_BURST_WINDOW_MS = 15000;
export const COMPATIBILITY_PROGRESS_REPORT_STARTUP_SECONDS = 45;
export const COMPATIBILITY_START_BUFFER_FRAGMENTS = 1;
export const COMPATIBILITY_RECOVERY_MIN_DELAY_MS = 1500;
export const COMPATIBILITY_RECOVERY_MAX_DELAY_MS = 30000;
export const COMPATIBILITY_SUBTITLE_WAIT_META = 'Waiting for subtitles to finish loading before playback starts.';
export const SUBTITLE_WINDOW_DURATION_SECONDS = 300;
export const SUBTITLE_WINDOW_SEEK_LEAD_SECONDS = 15;
export const SUBTITLE_WINDOW_SEEK_LAG_SECONDS = SUBTITLE_WINDOW_DURATION_SECONDS - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS;
export const SUBTITLE_WINDOW_OVERLAP_SECONDS = 1;
export const SUBTITLE_WINDOW_GAP_ACTION = 'pause-until-ready';
export const PROBE_STORAGE_KEY = 'dropbox-browser:video-probe-v1';
export const PROBE_STORAGE_TTL_MS = 60 * 60 * 1000;
export const PROBE_STORAGE_MAX_BYTES = 2 * 1024 * 1024;
export const SUBTITLE_PREVIEW_MAX_CHARS = 120;
