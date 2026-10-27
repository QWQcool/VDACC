package com.vdacc.app.bridge

/**
 * 桥的失败必须带**机器可读的错误码**，不能只给一句中文。
 * JS 侧 `BridgeError` 直接读 code 做分支（例如 ENOENT 触发续传、EACCES 提示授权），
 * 所以码值要和 JS 约定一致，不能随手改。
 */
class BridgeException(val code: String, override val message: String, cause: Throwable? = null) :
    Exception(message, cause)
