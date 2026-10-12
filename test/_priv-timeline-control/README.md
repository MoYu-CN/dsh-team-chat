# `_priv-timeline-control/` —— 「私聊往来不进聊天室」的**改动前快照**

这是 `test/priv-timeline-test.mjs` 的**对照组**：同一份脚手架跑两份插件源码，
生产那份（`lib/`）应当全绿，这份快照应当**红**。没有它，「过滤生效了」这句话
就只是断言，不是证据。

## 它是什么

`lib/index.js` 等文件是「加上私聊过滤**之前**」的那一版。跑法：

```bash
node test/priv-timeline-test.mjs test/_priv-timeline-control/lib/index.js <输出文件>
```

期望：**FAIL 2 条**

- `A1 私聊消息没有进房间时间线`
- `D2 落盘里没有私聊消息`

实测输出留了一份在 [`_priv-timeline-control.expected.txt`](../_priv-timeline-control.expected.txt)。

## 为什么只有这些文件（`lib/client.js` 被删掉了）

控制组只需要能被 `import` 起来的**宿主半**。`priv-timeline-test.mjs` 只加载
`lib/index.js`，而它的 import 只覆盖：

```
index.js → timeline-projection.js / member-store.js / room-log.js /
           room-tools.js / member-runtime.js / succession.js / team-bus.js
```

`lib/client.js`（357 KB，浏览器 bundle）**不在**这条链上 —— 没有任何文件 import 它。
它原先只是因为「快照要整包搬」才被一起带进来，而且里面有一处本机安装路径字面量。
所以删掉它：更小、也不再携带个人路径，**对照结论一个字都不变**
（删完重跑对照组，仍然是 `exit=1 / FAIL 2`）。

`package.json` 改名成 `package.json.snapshot` 同理：留着它这个目录会被 Node 认成
一个包边界（`{"type":"module"}`），而它是快照、不该被当成包。改名后 `import` 正常。

## ⚠ 改动这份快照的代价

它是「改前逻辑」的基准。**只要动了里面任何一行会影响行为的代码，它就不再是对照组。**
要改只能改上面说的那类「与行为无关的搬运」（删掉不参与 import 链的文件、改文件名）。
