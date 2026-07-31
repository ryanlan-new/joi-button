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
  // GitHub Pages serves this site from the repository subpath, so the production
  // default must stay '/joi-button/'. Container builds pass PUBLIC_PATH=/ instead.
  publicPath: process.env.PUBLIC_PATH || (process.env.NODE_ENV === 'production' ? '/joi-button/' : '/')
}