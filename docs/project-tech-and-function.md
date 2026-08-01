# 项目技术与功能文档（2026-03-24 快照，已不描述当前形态）

> **这份文档描述的是转型之前的站点。**它写于 2026-03-24，目的是为随后的改造提供一份现状底稿；改造已在 2026-07 完成，因此本文关于**部署方式**的部分现在全是错的，保留在这里是作为历史底稿，不再维护。
>
> 具体地说，以下几条在写下时为真、现在为假：
>
> | 本文说 | 实际已改为 |
> | --- | --- |
> | GitHub Actions 发布到 GitHub Pages（§2.4、§7.2） | Pages 发布已退役，`.github/workflows/deploy.yml` 已删除；现存的 `image.yml` 构建容器镜像 |
> | `deploy` 脚本用 `gh-pages -d dist`（§7.1） | `gh-pages` 脚本与依赖均已移除 |
> | 生产 `publicPath` 为 `/joi-button/`（§2.4、§7.3） | 现为 `process.env.PUBLIC_PATH \|\| '/'`，站点部署在域名根 |
> | 「静态站点」（§1） | 现为两个 Pod：nginx 提供前端与只读媒体，另一个提供投稿/审核 API，共享一个卷 |
> | `info.tlHelpers`（§9.3） | 已移除 |
>
> **语音目录也换了主语。**`src/voices.json` 与 `public/voices/` 现在是**基线**——`server/scripts/import-snapshot.mjs` 用它们给数据库播种一次；此后目录的真值在数据库里，新语音经站点投稿与审核进入，不再经仓库。§6 的数据结构描述对这份基线仍然成立。
>
> 当前形态的正本在 [`deploy/k8s/README.md`](../deploy/k8s/README.md)、[`deploy/runtime.env.example`](../deploy/runtime.env.example) 与 `server/` 各文件的头注释。
>
> 本文余下部分（§4 运行架构、§5 功能、§6 数据模型、§8 交互细节）描述前端，大体仍成立，但同样未随改造复核过——把它当**底稿**读，不要当判据。

本文档基于 2026-03-24 对当前仓库代码的静态检查整理，不包含联网环境、线上运行状态和未提交分支内容。

## 1. 项目概览

- 项目名称：`joi-button`
- `package.json` 中的包名仍为 `luna-button`
- 项目定位：为 VirtuaReal 成员 Joi 制作的语音按钮静态站点
- 运行形态：单页应用（SPA），当前只有一个首页路由
- 当前内容规模：
  - 语音分类 3 个
  - 语音条目 12 个
  - 支持语言 3 种：`zh-CN`、`en-US`、`ja-JP`

## 2. 技术栈

### 2.1 前端框架

- `Vue 2.7.16`
- `vue-router 3.4.5`
- `vue-i18n 8.21.1`
- `vue-class-component 6.3.2`

### 2.2 UI 与样式

- `Bootstrap 3.3.7`
- `jQuery 3.5.1`
- `Sass`
- `vue-country-flag` 用于语言切换中的国旗图标

### 2.3 构建工具

- `Vue CLI`
- `webpack 4.47.0`
- `babel-eslint`
- `eslint-plugin-vue`

### 2.4 部署方式

- 构建产物为纯静态文件
- GitHub Actions 自动部署到 GitHub Pages
- 生产环境 `publicPath` 为 `/joi-button/`

## 3. 目录与关键文件

| 路径 | 作用 |
| --- | --- |
| `src/main.js` | 应用入口，初始化 i18n、路由、全局事件总线 |
| `src/router.js` | 路由定义，当前仅首页 |
| `src/App.vue` | 全局框架，包含导航栏、语言切换、页脚、模态框挂载位 |
| `src/components/home.vue` | 核心业务页面，语音按钮和播放器控制都在这里 |
| `src/components/modal.vue` | Bootstrap 模态框组件，通过事件总线触发 |
| `src/voices.json` | 语音业务数据源，定义分类、文件路径和多语言文案 |
| `src/locales/*.js` | 基础 UI 文案的多语言文件 |
| `public/voices/` | 实际 mp3 资源目录 |
| `public/index.html` | HTML 模板、SEO 和 favicon 配置 |
| `vue.config.js` | jQuery 自动注入和生产路径配置 |
| `.github/workflows/deploy.yml` | GitHub Pages 发布流程 |

## 4. 运行架构

### 4.1 启动流程

应用从 `src/main.js` 启动，主要做了四件事：

1. 加载三套基础语言包：中文、英文、日文。
2. 读取 `src/voices.json`，把其中的语音分类标题和语音名称描述动态提取为 i18n 文案。
3. 注册 `vue-i18n`、路由和全局事件总线插件。
4. 根据浏览器语言设置默认语言，并挂载根组件 `App.vue`。

这意味着：

- 基础界面文案来自 `src/locales/*.js`
- 语音分类标题和语音按钮标题来自 `src/voices.json`
- 新增语音时，只要数据结构正确，按钮文案会自动进入多语言系统

### 4.2 页面结构

项目是标准的单页应用，但路由非常简单：

- `/`：首页，渲染 `src/components/home.vue`

`App.vue` 提供统一框架：

- 顶部导航栏
- 外部链接（Bilibili 主页）
- 语言切换下拉菜单
- 主内容容器
- 页脚说明
- 全局模态框组件

### 4.3 全局通信方式

项目没有使用 Vuex/Pinia，而是通过 `src/globalconst.js` 在 `Vue.prototype.$gConst` 上挂了一个 `new Vue()` 事件总线。

当前事件总线主要承担两类通信：

- `play`：通知播放器播放指定音频
- `send-info`：通知模态框显示提示信息

这是一个典型的早期 Vue 2 项目写法，适合当前简单页面，但扩展性一般。

## 5. 已实现功能

### 5.1 语音按钮列表

首页会遍历 `voices.json` 中的所有分类，并为每条语音生成一个按钮。

当前分类如下：

- `Cute Hummings`：1 条
- `Joi Alarm`：1 条
- `Arctic Eggs`：10 条

### 5.2 播放控制

首页控制区当前支持以下功能：

- 随机播放
- 停止当前语音
- 允许重叠播放
- 自动连播
- 单曲循环
- 音量调节
- 当前播放状态显示

### 5.3 三种播放模式的规则

项目把 `重叠播放`、`自动连播`、`单曲循环` 设计为互斥关系：

- 开启重叠播放时，自动连播和单曲循环不可用
- 开启自动连播时，重叠播放和单曲循环不可用
- 开启单曲循环时，重叠播放和自动连播不可用

具体行为如下：

- 普通播放：复用页面中的单个 `<audio>` 元素
- 重叠播放：每次点击新建一个 `Audio()` 实例，因此多个音频可同时播放
- 自动连播：当前音频播放结束后随机选择下一条语音
- 单曲循环：当前音频结束后再次播放同一条

### 5.4 音量控制

- 默认音量为 `80`
- 内部会换算为 `0.8`
- 音量 slider 只在 Bootstrap 的 `visible-md` / `visible-lg` 断点下显示，移动端默认不显示该控件

### 5.5 多语言

当前支持：

- 简体中文
- English
- 日本語

语言切换特性：

- 默认语言根据 `navigator.language` 推断
- 语言选择会写入 `localStorage.lang`
- 下次访问会优先读取 `localStorage` 中保存的语言

## 6. 数据模型

### 6.1 `voices.json` 结构

当前业务数据结构如下：

```json
{
  "voices": [
    {
      "categoryName": "分类唯一标识",
      "categoryDescription": {
        "zh-CN": "分类中文名",
        "en-US": "分类英文名",
        "ja-JP": "分类日文名"
      },
      "voiceList": [
        {
          "name": "语音唯一标识",
          "path": "public/voices 下的 mp3 文件名",
          "description": {
            "zh-CN": "按钮中文文案",
            "en-US": "按钮英文文案",
            "ja-JP": "按钮日文文案"
          }
        }
      ]
    }
  ]
}
```

### 6.2 数据与资源一致性

本次检查中已核对：

- `voices.json` 中声明的 mp3 数量：12
- `public/voices/` 中实际 mp3 数量：12
- 缺失文件：0
- 多余文件：0

当前数据与资源目录是一致的。

## 7. 构建与部署

### 7.1 当前可见脚本

`package.json` 中当前定义的脚本只有：

- `npm run build`
- `npm run deploy`
- `npm run predeploy`

其中：

- `build` 使用 `vue-cli-service build`
- `deploy` 使用 `gh-pages -d dist`

### 7.2 GitHub Actions 发布流程

`.github/workflows/deploy.yml` 当前逻辑：

1. 监听 `main` 分支 push
2. 使用 Node.js 20
3. 执行 `npm ci`
4. 执行 `npm run build`
5. 发布 `dist/` 到 GitHub Pages

### 7.3 静态资源路径

`vue.config.js` 把生产环境路径固定为：

```js
publicPath: process.env.NODE_ENV === 'production' ? '/joi-button/' : '/'
```

这说明项目默认假定自己部署在 GitHub Pages 的仓库子路径下，而不是域名根目录。

## 8. 页面与交互细节

### 8.1 SEO 与站点元信息

`public/index.html` 已配置：

- 页面标题
- description
- keywords
- Open Graph 标题、描述、站点名、图片
- favicon
- manifest
- theme color

### 8.2 路由模式

项目使用 `history` 路由模式。

因为当前只有首页，所以复杂度很低；如果未来增加多页面，需要确认 GitHub Pages 或其他静态托管环境对 history fallback 的处理方案。

### 8.3 缓存约束

README 中明确提到项目采用较强缓存策略，因此如果修改语音文件内容但文件名不变，客户端可能不会刷新。

对维护者的实际要求是：

- 新增或替换音频时，建议使用新文件名
- 修改旧音频后，避免继续使用原文件名

## 9. 当前状态与维护注意事项

### 9.1 文档与代码存在不一致

README 和 `README_zh-hans.md` 都写了本地开发时可执行 `npm run serve`，但当前 `package.json` 中并没有 `serve` 脚本。

这意味着：

- 现有 README 不能直接按字面执行
- 如果要恢复本地开发体验，需要补充 `serve` 脚本，或把 README 改成与现状一致

### 9.2 本次未执行构建验证

当前工作区没有 `node_modules/`，因此这次检查没有直接运行 `npm run build`。

换句话说：

- 文档基于代码结构和配置文件整理
- 未包含一次真实的本地构建结果

### 9.3 存在疑似历史遗留内容

以下内容目前看起来没有进入当前主流程，建议后续确认是否仍需保留：

- 依赖：`hls.js`
- 依赖：`jsencrypt`
- 依赖：`vue-slider-component`
- 工具文件：`src/util/copytext.js`
- 工具文件：`src/util/fetchpost.js`
- 旧部署文件：`.travis.yml`
- 加密私钥文件：`id_rsa.enc`
- `public/CNAME` 当前为空

### 9.4 中文语言包不完整

当前中文语言文件缺少部分在页面中已被使用的键，例如：

- `info.tlHelpers`
- `info.loopTips`
- `info.yt_channel`
- `info.lang`
- `action.loop`
- `action.volume`

这会导致中文环境下对应文案可能显示 key 名称，或者触发 i18n 缺失提示。

### 9.5 随机播放里有一段历史逻辑

随机播放逻辑仍然会排除名为 `blessings` 的分类，但当前 `voices.json` 中并不存在该分类。

这说明这段判断大概率是旧数据结构遗留下来的兼容代码。

## 10. 结论

这是一个典型的轻量级 Vue 2 静态语音按钮站点，当前代码规模不大，业务逻辑集中，数据驱动特征明显，适合继续以“单页 + JSON 数据源 + 静态部署”的方式维护。

如果后续要继续整理项目，优先级建议如下：

1. 先修正文档与脚本不一致的问题
2. 补齐中文语言包缺失键
3. 清理未使用依赖和历史部署残留
4. 视需要补充开发脚本、构建验证和更正式的维护文档
