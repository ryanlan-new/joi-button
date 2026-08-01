#Joi Button

[![Last Commit](https://img.shields.io/github/last-commit/ryanlan-new/joi-button)]()

[[简体中文](/README_zh-hans.md) | [English](README.md)]

![Joi-Button Cover](public/resources/embed/minijoi.png)

A Voice Button Website dedicated to VirtuaReal Liver Joi.

[Click here to visit https://space.bilibili.com/61639371](https://space.bilibili.com/61639371)

## Related Links:

* [Joi's Bilibili channel](https://space.bilibili.com/61639371)
* [Project technical and functional notes](docs/project-tech-and-function.md) — a snapshot of the site *before* the 2026-07 rebuild, kept as background; its deployment sections are no longer true

## Contributing

### Submitting a voice clip

**Voice clips are no longer submitted by Pull Request.** Use the site's own
submission page, linked from the header. It asks you to verify your identity
once: the site issues a one-time code, you post it as a danmaku in Joi's live
room, and the site reads your Bilibili open id from that message. Nothing
appears on the site until the owner approves it in the review queue.

This is deliberate. Clips, and the descriptions that come with them, are
somebody else's material, and a Pull Request writes them into this repository's
permanent public history, where taking them back later means rewriting history
for everyone who has ever cloned it. A database can forget a submission on
request. Git is not built to.

[src/voices.json](src/voices.json) and [public/voices](public/voices) are the
**baseline** catalogue — the clips this site launched with, which
`server/scripts/import-snapshot.mjs` seeds the database from once, at install
time. Adding a file there will not put it on the site: the live catalogue is
served from the database, not from this directory.

### Translation

Translations are maintained by the owner and are not open to contribution. The
locale files are the three `.js` files in [src/locales](src/locales); per-clip
names travel with the clip.

### Code

Code changes are welcome as Pull Requests — please fork, change, and open one.
For anything larger than a fix, an issue first saves us both the round trip.

## Deploying a local development environment

This site is developed using Vue + jQuery + Bootstrap 3.

To deploy a local development environment, first install the latest version of Node. Then follow these steps:

1. Clone the code.

2. Go to the code directory and run `npm install`.

3. Run `npm run serve`. During the code modification process, this local development server can immediately reflect the results of the modification.

4. To compile the frontend, run `npm run build`, which generates the `dist` directory.

`dist/` is what the web container serves, but it is no longer the whole site: submission, review and the live catalogue are served by the API in [server/](server), which keeps its database and media on a shared volume. Running the two together is described in [deploy/k8s/README.md](deploy/k8s/README.md).

> To contribute your code to this project, you don't have to compile locally. After passing the test in the development server and pushing it to Github, you can directly require a Pull Request to this project.

## LICENSE
[![LICENSE](https://img.shields.io/github/license/ryanlan-new/joi-button)](LICENSE)

Program: MIT

This project is a work of fans and is not related to the official VirtuaReal or Nijisanji.

## Special Thanks

This project is modified based on monoAI's [Luna button](https://github.com/monoai)
