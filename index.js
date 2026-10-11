/**
 * Host 那一半 —— 故意是空的。
 *
 * 面板的数据来自本机的「进度中枢」（progress/hub.py，一个只读的 HTTP 服务），
 * 浏览器那边直接 fetch 它，所以 Host 侧不需要注册服务、工具或事件。
 *
 * 这样做的理由：不用 typert 代码生成、不用编译、不 import 任何 DSH 客户端包，
 * 整个插件就是两个纯文本 JS 文件，装坏的概率最低。
 */

export function apply() {}
