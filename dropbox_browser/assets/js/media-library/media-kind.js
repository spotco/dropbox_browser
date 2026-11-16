const PRESENTATIONS = Object.freeze({
  music: Object.freeze({
    kind: 'music',
    itemNounSingular: 'song',
    itemNounPlural: 'songs',
    playlistItemsLabel: 'Songs',
    playlistLoadButtonLabel: 'Playlists',
    playlistLoadLabel: 'Load Playlist: Songs',
    playlistExportFilename: 'dropbox_browser_music_playlists.json',
  }),
  videos: Object.freeze({
    kind: 'videos',
    itemNounSingular: 'video',
    itemNounPlural: 'videos',
    playlistItemsLabel: 'Videos',
    playlistLoadButtonLabel: 'Playlists',
    playlistLoadLabel: 'Load Playlist: Videos',
    playlistExportFilename: 'dropbox_browser_videos_playlists.json',
  }),
});

export function mediaKindPresentation(kind) {
  var normalized = String(kind || '').toLowerCase();
  return PRESENTATIONS[normalized === 'video' ? 'videos' : normalized] || PRESENTATIONS.music;
}

export function formatMediaItemCount(count, kind) {
  var presentation = mediaKindPresentation(kind);
  var safeCount = Math.max(0, Number(count) || 0);
  var noun = safeCount === 1 ? presentation.itemNounSingular : presentation.itemNounPlural;
  return String(safeCount) + ' ' + noun;
}
