package com.vdacc.app.bridge

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import org.json.JSONObject
import java.nio.ByteBuffer

/**
 * 音视频合并（B站 DASH 是 video-only + audio-only 两条流）。
 *
 * 为什么用 framework 的 `MediaExtractor` + `MediaMuxer` 而不是 Media3：
 * 1. 这里要的是**纯封装转换**（-c copy），不解码不重编码。Media3 的 Transformer 面向
 *    「加特效/转码」，走它会额外解码一遍，20 秒的 1080P 视频在手机上要多花几十秒，
 *    还会引入 ~1MB 依赖；`MediaMuxer` 在 API 26 就有，依赖清单仍然可以是空的。
 * 2. 设计稿（`docs/design/android-standalone-plan.md` §9）写的是 Media3，但它的用途是
 *    「合并 + 超限拆轨」；用 framework 实现同一件事不改变契约，出问题也能换回 Media3
 *    （对外只有 `media.mux` 一个方法）。
 *
 * 三个容易忽略但会直接毁掉产物的点：
 * - **codec config 不能当样本写**：`BUFFER_FLAG_CODEC_CONFIG` 的那帧已经由 `addTrack(format)`
 *   带进 muxer，再写一次会得到无法播放的文件；
 * - **旋转角要传给 muxer**：手机拍的视频/部分稿件带 `KEY_ROTATION`，丢掉会让成片方向错；
 * - **失败必须留可重试的分离流**：`mux` 出错只删自己的输出，输入 `.part` 原样保留，
 *   上层可以改成拆轨或者重试。
 */
class Media(private val fs: Fs) {

    companion object {
        /** 单次拷贝缓冲：fMP4 的一帧最多几 MB，2MB 足够且不占内存。 */
        private const val DEFAULT_BUFFER = 2 * 1024 * 1024
    }

    fun mux(videoRaw: String, audioRaw: String, outRaw: String): JSONObject {
        val videoName = fs.safeName(videoRaw)
        val outName = fs.safeName(outRaw)
        val videoFile = fs.stagingFile(videoName)
        if (!videoFile.exists()) {
            throw BridgeException("ENOENT", "视频轨不在暂存区：${videoFile.absolutePath}")
        }
        val audioFile = if (audioRaw.isBlank()) null else fs.stagingFile(fs.safeName(audioRaw)).also {
            if (!it.exists()) throw BridgeException("ENOENT", "音频轨不在暂存区：${it.absolutePath}")
        }
        val outFile = fs.stagingFile(outName)
        if (outFile.exists() && !outFile.delete()) {
            throw BridgeException("EACCES", "无法覆盖已有的 ${outFile.absolutePath}")
        }

        val videoExtractor = MediaExtractor()
        val audioExtractor = audioFile?.let { MediaExtractor() }
        var muxer: MediaMuxer? = null
        try {
            videoExtractor.setDataSource(videoFile.absolutePath)
            val vTrack = pickTrack(videoExtractor, "video/")
                ?: throw BridgeException("media_mux_unsupported", "视频轨里没有 video/* 轨道，无法合并")
            videoExtractor.selectTrack(vTrack)
            val vFormat = videoExtractor.getTrackFormat(vTrack)

            var aFormat: MediaFormat? = null
            if (audioExtractor != null) {
                audioExtractor.setDataSource(audioFile.absolutePath)
                val aTrack = pickTrack(audioExtractor, "audio/")
                    ?: throw BridgeException("media_mux_unsupported", "音频轨里没有 audio/* 轨道，无法合并")
                audioExtractor.selectTrack(aTrack)
                aFormat = audioExtractor.getTrackFormat(aTrack)
            }

            val rotation = if (vFormat.containsKey(MediaFormat.KEY_ROTATION)) {
                vFormat.getInteger(MediaFormat.KEY_ROTATION)
            } else 0

            val created = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = created
            if (rotation == 90 || rotation == 180 || rotation == 270) created.setOrientationHint(rotation)

            val vOut = created.addTrack(vFormat)
            val aOut = aFormat?.let { created.addTrack(it) } ?: -1
            created.start()

            val bufferSize = maxOf(
                bufferSizeOf(vFormat),
                if (aFormat != null) bufferSizeOf(aFormat) else 0,
                DEFAULT_BUFFER,
            )
            val buffer = ByteBuffer.allocateDirect(bufferSize)
            val info = MediaCodec.BufferInfo()

            var videoDone = false
            var audioDone = aFormat == null
            while (!videoDone || !audioDone) {
                // 按最早时间戳交替取样本：muxer 要求时间单调，分开写完再交错会得到坏文件
                val takeVideo = when {
                    videoDone -> false
                    audioDone -> true
                    else -> {
                        val vt = videoExtractor.sampleTime
                        val at = audioExtractor!!.sampleTime
                        vt >= 0 && (at < 0 || vt <= at)
                    }
                }
                if (takeVideo) {
                    videoDone = !copySample(videoExtractor, vOut, created, buffer, info)
                } else {
                    audioDone = !copySample(audioExtractor!!, aOut, created, buffer, info)
                }
            }

            created.stop()
            created.release()
            muxer = null

            val durationUs = maxOf(trackDuration(vFormat), aFormat?.let { trackDuration(it) } ?: 0)
            val bytes = outFile.length()
            if (bytes <= 0) throw BridgeException("media_mux_failed", "合并产物是 0 字节")

            // 合并成功才删分离流：失败时它们是重试与拆轨的唯一来源
            videoFile.delete()
            audioFile?.delete()

            return JSONObject()
                .put("name", outName)
                .put("bytes", bytes)
                .put("tracks", if (aFormat != null) 2 else 1)
                .put("durationUs", durationUs)
                .put("rotation", rotation)
                .put("videoCodec", vFormat.getString(MediaFormat.KEY_MIME) ?: "")
                .put("audioCodec", aFormat?.getString(MediaFormat.KEY_MIME) ?: "")
        } catch (error: BridgeException) {
            outFile.delete()
            throw error
        } catch (error: Exception) {
            outFile.delete()
            throw BridgeException(
                "media_mux_failed",
                "合并失败：${error.javaClass.simpleName} ${error.message ?: ""}".trim(),
                error,
            )
        } finally {
            try { muxer?.release() } catch (_: Exception) { }
            try { videoExtractor.release() } catch (_: Exception) { }
            try { audioExtractor?.release() } catch (_: Exception) { }
        }
    }

    private fun pickTrack(extractor: MediaExtractor, prefix: String): Int? {
        for (index in 0 until extractor.trackCount) {
            val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith(prefix)) return index
        }
        return null
    }

    private fun bufferSizeOf(format: MediaFormat): Int =
        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0

    private fun trackDuration(format: MediaFormat): Long =
        if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L

    /** 拷一个样本；返回 false 表示这条轨已经到底。 */
    private fun copySample(
        extractor: MediaExtractor,
        trackOut: Int,
        muxer: MediaMuxer,
        buffer: ByteBuffer,
        info: MediaCodec.BufferInfo,
    ): Boolean {
        buffer.clear()
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) return false
        val flags = extractor.sampleFlags
        val time = extractor.sampleTime
        extractor.advance()
        // 参数集已经由 addTrack(format) 写进 muxer，这里再写一次会得到打不开的文件
        if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) return true
        info.set(0, size, time, flags and MediaCodec.BUFFER_FLAG_KEY_FRAME)
        muxer.writeSampleData(trackOut, buffer, info)
        return true
    }
}
