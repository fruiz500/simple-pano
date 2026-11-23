Libraries that Simple Pano needs, kept here so the app makes no outside calls for them:

  three.min.js                 three.js r128 (MIT, see LICENSE-three.txt), build/three.min.js
  DeviceOrientationControls.js three.js r128, examples/js/controls/ (steers the view by moving the device)
  exifr.lite.umd.js            exifr 7.1.3, lite build (MIT, see LICENSE-exifr.txt): reads the capture time from photos

The styles are in ../pano.css, built with Tailwind CSS 3 from the class names used in index.html and the .js files.
To rebuild it after adding or changing classes (needs Node):

  npm install tailwindcss@3
  npx tailwindcss -c tailwind.config.js -i tailwind.input.css -o pano.css --minify

tailwind.config.js and tailwind.input.css are in the project folder.
