(function () {
  var pane = document.getElementById('music-player-pane');
  if (!pane) return;

  var controls = pane.querySelector('.music-player-controls');
  pane.setAttribute('data-player-ready', 'stub');
  if (controls) controls.setAttribute('data-controls-ready', 'stub');
}());
