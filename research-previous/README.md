# Gun Mayhem Netplay

这个仓库现在有两个版本：

```text
npm start             旧版：Ruffle + patched SWF 房主权威外壳，端口 3000
npm run start:modern  新版：真正 Node 服务器权威移植版，端口 3001
```

如果你追求公平，应该使用 `npm run start:modern`。新版入口文档在 `server-authoritative/README.md`。

这个项目把本地的 `gunmayhem.swf` 包成一个可以联网进入同一房间的浏览器版。浏览器用 Ruffle 运行 Flash，Node.js 服务负责房间、座位和按键转发。

当前默认加载的是 `gunmayhem_authority_patch.swf`。这个文件来自 FFDec 反编译后的 ActionScript 修改版：玩家脚本里的直接读键 `Key.isDown(...)` 已经被替换为 `NETKEY(...)`，并新增了 `NETROLE()`、`NETPUSHPLAYER()`、`NETAPPLYPLAYER()`。

联网架构是“玩家 1 房主权威”：

```text
玩家 2 输入 -> WebSocket 服务器 -> 玩家 1 浏览器
玩家 1 的 patched SWF 运行真实物理/命中
玩家 1 patched SWF 每帧推送玩家状态 -> WebSocket 服务器 -> 玩家 2 浏览器
玩家 2 patched SWF 用房主状态覆盖本地玩家显示
玩家 1 patched SWF 通过 CP/CP2 创建子弹、箱子、爆炸等对象时 -> 广播给玩家 2 重放
```

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:3000
```

一个人选择“玩家 1”进入房间，复制页面下方的分享链接给另一个人。另一个人打开链接后会默认使用“玩家 2”。

## 控制方式

两边都可以用：

```text
WASD / 方向键移动，J 射击，K 炸弹
```

网页会根据座位把按键映射回原 Flash 游戏的本地双人键位：

```text
玩家 1：方向键 + [ / ]
玩家 2：WASD + T / Y
```

如果这个 SWF 实际用的是 Gun Mayhem 2 键位，把页面上的“键位”切到 `GM2: Z / X`。

## 公网部署

需要部署到支持 WebSocket 的 Node.js 平台，例如 Render、Railway、Fly.io 或自己的 VPS。部署后两个人访问同一个公网地址即可。

平台设置通常是：

```text
Build command: npm install
Start command: npm start
Port: 使用平台提供的 PORT 环境变量
```

项目也带了 `Dockerfile`，可以直接按容器应用部署。

## 重要限制

这是“已反编译并打了房主权威补丁”的原 SWF。它比纯键盘事件注入更干净，因为游戏逻辑会主动从网页查询每个玩家的输入状态，玩家 2 的本地玩家状态会被玩家 1 的真实游戏状态覆盖，并且通过 `_root.CP(...)` / `_root.CP2(...)` 生成的大多数临时对象会从玩家 1 广播到玩家 2。

当前同步粒度覆盖了玩家状态和大多数 `CP/CP2` 生成对象，但还不是从零重写的专用网络游戏引擎。仍建议玩家 1 作为房主负责选菜单和开局，玩家 2 通过分享链接加入同一个房间。若遇到菜单流程不同步，点击“同步重载”后由房主重新开局。
