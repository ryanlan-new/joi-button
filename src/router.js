import Vue from 'vue'
import Router from 'vue-router'

import HomePage from './components/home.vue'

Vue.use(Router)

export default new Router({
  mode: 'history',
  base: process.env.BASE_URL,
  routes: [
    {path: '/', name: "home", component: HomePage},
    // Both hosting paths answer an unknown deep link with index.html (nginx
    // try_files in the container, 404.html on GitHub Pages). Without a
    // catch-all the router then matches nothing and renders a blank page, so
    // send it home instead.
    {path: '*', redirect: '/'},
  ]
})
