# manifest.json 的 `key` 字段与扩展 ID

> 关于 Chrome 扩展 `manifest.json` 中 `key` 字段（商店公钥）的说明。
> About the `key` field (Chrome Web Store public key) in `manifest.json`.

## 这是什么

`manifest.json` 里的 `key` 是本扩展在 Chrome Web Store 的**公钥**（base64 编码的 DER
SubjectPublicKeyInfo）。它是发布者身份的一部分，**不是 API Key**，不含任何机密，可以安全地
保留在仓库和上传包中。

从 1.4.3 起，仓库的 `manifest.json` 显式携带该字段，用于把 unpacked（开发者模式「加载已解压的
扩展程序」）安装与商店安装钉在**同一个扩展 ID** 上：

```
lmdbhjngjhlgbpmbjfffegjalchblpke
```

（商店地址：https://chromewebstore.google.com/detail/lmdbhjngjhlgbpmbjfffegjalchblpke ）

## 为什么需要它

- 没有 `key` 时，unpacked 安装的 ID 由本地目录路径哈希生成，与商店 ID 不同，相当于另一个
  扩展：`chrome.storage.local` 里已保存的 API Key、设置互不通用，从 unpacked 升级到商店版
  （或反过来）需要重新输入 Key。
- 带上与商店一致的 `key` 后，两种安装方式得到同一 ID，同一份存储，Key 无需重填。

## ID 如何从 key 推导（校验用）

Chrome 的规则：对 base64 解码后的 DER 公钥字节做 SHA-256，取前 16 字节（32 个 nibble），
每个 nibble 按 `0-15 → a-p` 映射成小写字母，拼成 32 字符的 ID。

`scripts/ci-check.mjs` 会在 CI 里执行该校验：`manifest.key` 必须存在，且按上述算法推导出的
ID 必须等于上面的商店 ID，否则构建失败。本地也可以随时手验：

```bash
node -e '
const crypto = require("node:crypto");
const manifest = require("../manifest.json");
const hash = crypto.createHash("sha256")
  .update(Buffer.from(manifest.key, "base64")).digest();
let id = "";
for (let i = 0; i < 16; i++) {
  id += String.fromCharCode(97 + (hash[i] >> 4));
  id += String.fromCharCode(97 + (hash[i] & 0xf));
}
console.log(id); // lmdbhjngjhlgbpmbjfffegjalchblpke
'
```

## 上传 CWS 时的注意事项

- Chrome Web Store **接受**包含 `key` 字段的上传包，前提是该 key 与商店条目的公钥一致
  （本仓库的 zip 即属此种情况，直接上传即可）。
- 如果 `key` 与商店条目的公钥**不一致**，CWS 会在上传/处理阶段拒绝；此时应先从
  `manifest.json` 移除 `key` 字段再打包上传（商店会用条目自身的公钥签名，ID 不变）。
- 打包仍用 `node scripts/pack.mjs`；zip 清单由 manifest 引用推导，`key` 字段不影响打包
  文件列表。

## 与 API Key 的关系

无关。`manifest.key` 是扩展身份公钥；DeepSeek / Kimi 的 API Key 只保存在用户本机的
`chrome.storage.local`（见弹窗「设置备份」的导出/导入，默认不含 Key），永不进入仓库或
上传包。
