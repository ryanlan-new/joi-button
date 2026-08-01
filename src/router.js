import Vue from 'vue'
import Router from 'vue-router'

import HomePage from './components/home.vue'

Vue.use(Router)

/**
 * What a visitor sees when the page's own JavaScript chunk cannot be fetched.
 *
 * Two different things land here and both are outside the app's control:
 *
 *   * A deploy happened while this tab sat open. deploy/nginx.conf serves
 *     /js/*.<hash>.js `immutable` for a year, so the tab is holding a router
 *     that names chunk files the new deployment does not contain, and the
 *     request 404s. Nothing inside this page load can repair that — only a
 *     reload, which fetches the new index.html and with it the new names.
 *   * The network dropped between the first load and the click.
 *
 * A render function rather than a template: vue-cli builds the runtime-only Vue,
 * which has no template compiler, so a `template:` string here would render
 * nothing at all — in the one component whose entire job is to not render
 * nothing.
 */
const ChunkUnavailable = {
  name: 'ChunkUnavailable',
  render(h) {
    return h('div', { class: 'container-fluid' }, [
      h('div', { class: 'cate-header' }, this.$t('submit.chunk.title')),
      // .cate-body, not a bare div: the five measured button states in App.vue
      // are declared as `.cate-body button:hover` and friends, so a button
      // outside it renders with the resting fill and no hover, focus or active
      // colour at all.
      h('div', { class: 'cate-body' }, [
        h('p', this.$t('submit.chunk.body')),
        h(
          'button',
          {
            class: 'btn btn-info',
            attrs: { type: 'button' },
            on: { click: () => window.location.reload() },
          },
          this.$t('submit.action.reload'),
        ),
        // .btn-new and not .btn-info: App.vue styles .btn-info only through
        // `.cate-body button.btn-info`, an ELEMENT selector, so on an <a> it
        // falls through to Bootstrap's stock white-on-#5bc0de at 2.2:1. Measured
        // in a browser, on this very page, where it rendered blue. .btn-new is a
        // class selector and carries the white fill with plum ink at 8.99:1.
        h('router-link', { class: 'btn btn-new', props: { to: '/' } }, this.$t('submit.action.home')),
      ]),
    ])
  },
}

/**
 * A lazily-loaded route component that degrades instead of blanking the page.
 *
 * vue-router resolves async route components ITSELF, before it confirms the
 * navigation (resolveAsyncComponents), so Vue's own advanced async component
 * syntax — the `{ component, error, loading }` object — never gets to show its
 * `error` component here: the rejection goes to router.onError and the
 * navigation is simply abandoned, leaving the visitor looking at the page they
 * tried to leave, or at an empty <router-view> on a cold load. Catching the
 * rejection and RESOLVING with a component is what puts something on the screen.
 *
 * One retry first, because a chunk that failed on a flaky connection usually
 * arrives on the second ask, and webpack drops the failed chunk from its
 * registry so the retry is a real request rather than a cached rejection. A
 * chunk that is genuinely gone fails twice and costs the visitor half a second.
 */
function page(load) {
  return () =>
    load()
      .catch(() => new Promise((resolve) => setTimeout(resolve, 400)).then(load))
      .catch(() => ChunkUnavailable)
}

export default new Router({
  mode: 'history',
  base: process.env.BASE_URL,
  routes: [
    {path: '/', name: "home", component: HomePage},
    // Lazy, and each in its own chunk: most visitors come to press buttons and
    // never send anything, and they should not download the batch editor, its
    // three-language copy and the upload machinery to do it.
    {
      path: '/submit',
      name: 'submit',
      component: page(() => import(/* webpackChunkName: "submit" */ './components/submit.vue')),
    },
    {
      path: '/my',
      name: 'my',
      component: page(() => import(/* webpackChunkName: "my" */ './components/my.vue')),
    },
    // The review desk. No navigation guard, and that is not an omission: a guard
    // here could only ask the server whether this visitor is an admin, which is
    // exactly what AdminDesk.probe() already does on mount — it GETs
    // /api/admin/queue and, on 401/403/404, calls $router.replace('/'). The
    // server answers a stranger with 404 rather than 403 precisely so that the
    // desk's existence is not confirmed to them, and a client-side guard cannot
    // improve on that: whatever it decided, the data still lives behind the API.
    // A guard would only add a second place for the answer to be wrong.
    //
    // Its own chunk, like the other two. Most visitors are not the owner.
    {
      path: '/admin',
      name: 'admin',
      component: page(() => import(/* webpackChunkName: "admin" */ './components/admin/AdminDesk.vue')),
    },
    // Both hosting paths answer an unknown deep link with index.html (nginx
    // try_files in the container, 404.html on GitHub Pages). Without a
    // catch-all the router then matches nothing and renders a blank page, so
    // send it home instead. It stays LAST: a redirect declared above the two
    // routes over it would swallow them.
    {path: '*', redirect: '/'},
  ]
})
