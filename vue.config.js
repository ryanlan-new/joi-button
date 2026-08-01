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
  publicPath: process.env.PUBLIC_PATH || '/',

  // `npm run serve` in front of a locally running API.
  //
  // src/api.mjs deleted the API base prefix: every call in the app is
  // root-relative, because deploy/k8s/ingress.yaml puts /api on the site's own
  // host. That is true in the cluster and false on a laptop, where the dev
  // server owns :8080 and the API owns another port — so without this, '/api/me'
  // would hit webpack-dev-server, which answers the SPA fallback, and the app
  // would try to parse index.html as JSON.
  //
  // Proxying rather than reintroducing the prefix is what keeps the two
  // environments the same shape: the code under test makes exactly the request
  // it makes in production, and the difference lives in this file instead of in
  // a variable that has to be right in four build paths.
  //
  // ONLY /api is proxied, and that is a correction rather than a shortcut: the
  // API does NOT serve /catalog.json or /media. Every route it has is under
  // /api (routes/public.mjs, routes/admin.mjs), and in the cluster those two
  // paths are nginx's own — deploy/nginx.conf aliases them onto the shared
  // volume, which is why the site keeps serving current data while the API pod
  // restarts. Proxying them to the API would 404 in dev and teach the wrong
  // model of the deployment.
  //
  // They are served here the same way nginx serves them: as static files, from
  // a directory that holds ONLY the two published things. Point JOI_PUBLIC_DIR
  // at it, and run the API with CATALOG_FILE and MEDIA_DIR inside it — the
  // database and the upload staging directory stay outside, exactly as they do
  // on the volume, so a dev run cannot serve something production would not.
  //
  //   DATA_DIR=/tmp/joi          # joi.db, incoming/  — served by nothing
  //   CATALOG_FILE=/tmp/joi/public/catalog.json
  //   MEDIA_DIR=/tmp/joi/public/media
  //   JOI_PUBLIC_DIR=/tmp/joi/public
  //
  // JOI_API_ORIGIN overrides the API's port for anyone running it elsewhere.
  devServer: {
    proxy: {
      '^/api($|/)': {
        target: process.env.JOI_API_ORIGIN || 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
    // `contentBase`, not `static`: this project is on webpack-dev-server 3.11
    // (vue-cli 5 pins it for the Vue 2 preset), where `static` is not a valid
    // option at all — the server refuses to start with "options should NOT have
    // additional properties" and no mention of which one. `static` is the
    // webpack-dev-server 4 spelling.
    //
    // Two roots, both at '/': the app's own public/ (the default, which naming
    // contentBase would otherwise replace) and the published directory. Absent
    // JOI_PUBLIC_DIR only the default is listed, so `npm run serve` with no API
    // behaves exactly as it did.
    contentBase: process.env.JOI_PUBLIC_DIR
      ? [require('path').resolve(__dirname, 'public'), process.env.JOI_PUBLIC_DIR]
      : [require('path').resolve(__dirname, 'public')],
    contentBasePublicPath: '/',
  },
}