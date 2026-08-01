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
  // The three paths are the three the web pod serves or routes:
  //   /api          the API (ingress rule)
  //   /catalog.json the published catalogue (nginx alias onto the shared volume)
  //   /media        published clips        (nginx alias onto the shared volume)
  // In the cluster the last two are nginx's own files; in dev the API's data
  // directory is the only place they exist, so the API serves them there.
  //
  // JOI_API_ORIGIN overrides the port for anyone running the API elsewhere.
  devServer: {
    proxy: {
      '^/(api|media)($|/)': {
        target: process.env.JOI_API_ORIGIN || 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
      '^/catalog\\.json$': {
        target: process.env.JOI_API_ORIGIN || 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
}