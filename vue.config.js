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
  }
}

export default defineConfig({
  base: process.env.NODE_ENV === 'production' 
    ? '/joi-button/'  // 必须与仓库名一致
    : '/',
  build: {
    assetsDir: 'static',
    manifest: true
  }
})