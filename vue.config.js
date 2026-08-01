const webpack = require('webpack');

module.exports = {
  configureWebpack: {
    plugins: [
      new webpack.ProvidePlugin({
            $: 'jquery',
            jQuery: 'jquery',
            'window.jQuery': 'jquery'
      })
    ]
  },
  // Domain root, in every mode.
  //
  // This defaulted to '/joi-button/' in production, because GitHub Pages served
  // the site from the repository subpath. Pages is retired: it serves static
  // files and nothing else, so a project with a backend cannot run there at all
  // — /api/* would have nowhere to go. The only deployment now is the container,
  // which serves from the root of its own host.
  //
  // PUBLIC_PATH stays as an override rather than being deleted: a future
  // deployment under a subpath would need it, and the Dockerfile already threads
  // it through as a build arg. Nothing in the repository sets it to anything but
  // '/', and deploy/smoke-image.sh refutes any '/joi-button/' asset path in the
  // built output, so a return of the old prefix fails a gate rather than a page.
  publicPath: process.env.PUBLIC_PATH || '/'
}