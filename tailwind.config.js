// Builds pano.css (see vendor/README.txt). The class names are read from the page and the scripts that add or change them.
module.exports = {
  content: ['./index.html', './help.html', './pano_app.js', './stitch_ai.js', './pano_align.js', './pano_seams.js', './pano_features.js'],
  theme: { extend: {} },
  plugins: [],
};
