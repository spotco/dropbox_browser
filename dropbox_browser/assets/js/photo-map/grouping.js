const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_LATITUDE_DEGREE = 111320;

function pathForItem(item) {
  return String((item && (item.photoMapSourcePath || item.path)) || '');
}

function isGroupableMedia(item) {
  var kind = String((item && (item.mediaKind || item.photoMapMediaKind)) || 'photo');
  return kind === 'photo' || kind === 'video';
}

function newestMediaTimestamp(item) {
  var listingDate = Number(item && (item.listingDateMs || item.photoMapListingDateMs));
  if (Number.isFinite(listingDate)) return listingDate;
  var captureDate = Number(item && item.captureDateMs);
  return Number.isFinite(captureDate) ? captureDate : -Infinity;
}

function newestThumbnailMember(members) {
  var newest = null;
  var newestTimestamp = -Infinity;
  members.forEach(function (item) {
    var timestamp = newestMediaTimestamp(item);
    // Keep the source ordering as a stable tiebreaker. Candidates are already
    // newest-first by listing date before they reach the grouping helper.
    if (!newest || timestamp > newestTimestamp) {
      newest = item;
      newestTimestamp = timestamp;
    }
  });
  return newest;
}

function coordinatesForItem(item) {
  if (!item || !Number.isFinite(Number(item.latitude)) || !Number.isFinite(Number(item.longitude))) return null;
  return {lat: Number(item.latitude), lon: Number(item.longitude)};
}

function distanceMeters(left, right) {
  var radians = Math.PI / 180;
  var lat1 = left.lat * radians;
  var lat2 = right.lat * radians;
  var dLat = (right.lat - left.lat) * radians;
  var dLon = (right.lon - left.lon) * radians;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function cellKey(point, radiusMeters) {
  var longitudeMeters = METERS_PER_LATITUDE_DEGREE * Math.max(0.01, Math.abs(Math.cos(point.lat * Math.PI / 180)));
  var x = Math.floor((point.lon * longitudeMeters) / radiusMeters);
  var y = Math.floor((point.lat * METERS_PER_LATITUDE_DEGREE) / radiusMeters);
  return {x: x, y: y};
}

function averageCenter(members) {
  var total = members.reduce(function (sum, item) {
    var point = coordinatesForItem(item);
    return {lat: sum.lat + point.lat, lon: sum.lon + point.lon};
  }, {lat: 0, lon: 0});
  return {
    latitude: total.lat / members.length,
    longitude: total.lon / members.length,
  };
}

function groupedRecord(group) {
  var members = group.members.slice();
  var center = averageCenter(members);
  var firstPath = pathForItem(members[0]);
  var thumbnailMember = newestThumbnailMember(members);
  var videoCount = members.filter(function (item) {
    return String((item && (item.mediaKind || item.photoMapMediaKind)) || 'photo') === 'video';
  }).length;
  return {
    path: 'photo-map-group:' + firstPath,
    photoMapSourcePath: 'photo-map-group:' + firstPath,
    photoMapMediaKind: 'photo',
    mediaKind: 'photo',
    photoMapGrouped: true,
    photoMapGroupId: 'photo-map-group:' + firstPath,
    photoMapGroupCount: members.length,
    photoMapGroupVideoCount: videoCount,
    photoMapGroupPhotoCount: members.length - videoCount,
    photoMapGroupMembers: members,
    // The group itself is represented by one newest-media thumbnail. Keep
    // its source member explicit so the shared browser scheduler can request
    // and update only that thumbnail while the pin is visible.
    photoMapGroupThumbnailPath: thumbnailMember ? pathForItem(thumbnailMember) : '',
    photoMapThumbnailUrl: thumbnailMember && thumbnailMember.photoMapThumbnailUrl
      ? thumbnailMember.photoMapThumbnailUrl : '',
    photoMapThumbnailState: thumbnailMember && thumbnailMember.photoMapThumbnailState
      ? thumbnailMember.photoMapThumbnailState : '',
    latitude: center.latitude,
    longitude: center.longitude,
    display_name: String(members.length) + ' media items',
  };
}

/*
 * Groups located photos and videos around a stable anchor, not through
 * transitive chaining. A member is eligible only when it is within radiusMeters of the first media item
 * that created the group. A small geographic grid limits neighbor checks to
 * nearby anchors while keeping the output deterministic in listing order.
 */
export function groupPhotoMapItems(items, radiusMeters) {
  var radius = Number(radiusMeters);
  var source = Array.isArray(items) ? items : [];
  if (!Number.isFinite(radius) || radius <= 0) return source.slice();
  var groups = [];
  var grid = new Map();
  var outputRecords = [];

  function addGroup(item, index, point) {
    var group = {anchor: point, members: [item], firstIndex: index};
    var cell = cellKey(point, radius);
    var key = cell.x + ':' + cell.y;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(group);
    groups.push(group);
    return group;
  }

  source.forEach(function (item, index) {
    if (!isGroupableMedia(item)) {
      outputRecords.push({item: item, firstIndex: index});
      return;
    }
    var point = coordinatesForItem(item);
    if (!point) {
      outputRecords.push({item: item, firstIndex: index});
      return;
    }
    var cell = cellKey(point, radius);
    var match = null;
    for (var x = cell.x - 1; x <= cell.x + 1 && !match; x += 1) {
      for (var y = cell.y - 1; y <= cell.y + 1 && !match; y += 1) {
        var nearby = grid.get(x + ':' + y) || [];
        nearby.some(function (group) {
          if (distanceMeters(group.anchor, point) <= radius) {
            match = group;
            return true;
          }
          return false;
        });
      }
    }
    if (match) match.members.push(item);
    else addGroup(item, index, point);
  });

  groups.forEach(function (group) {
    outputRecords.push({
      item: group.members.length > 1 ? groupedRecord(group) : group.members[0],
      firstIndex: group.firstIndex,
    });
  });
  return outputRecords.sort(function (left, right) { return left.firstIndex - right.firstIndex; })
    .map(function (entry) { return entry.item; });
}

export {distanceMeters as photoMapDistanceMeters};
