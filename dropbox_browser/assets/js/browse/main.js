(function () {
  var body = document.body;
  if (!body || body.dataset.clientRender !== '1') return;
  var mount = document.getElementById('browse-rows');
  if (!mount) return;
  body.dataset.browseClient = 'placeholder';
}());
