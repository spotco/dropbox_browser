// Text for the banner shown above the browse table when the server could not
// get a live Dropbox listing (payload.listing.remote_error).  With
// payload.listing.stale the rows come from the last good listing; otherwise
// only local rows are shown and their Dropbox status is unknown.
export function listingWarningMessage(listing) {
  if (!listing || !listing.remote_error) return '';
  if (listing.stale) {
    var when = listing.stale_cached_display ? ' from ' + listing.stale_cached_display : '';
    return 'Dropbox listing unavailable, showing the last known Dropbox listing' + when +
      '. Statuses may be out of date.';
  }
  return 'Dropbox listing unavailable, showing local files only. Dropbox status is unknown.';
}
