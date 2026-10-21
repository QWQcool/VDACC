<!--
  infOS 薄页面参考实现（Vue 3 <script setup>）。
  用法：把本文件放进 infOS 的某个 app 页面，传 baseUrl（如 http://127.0.0.1:8765）与 token。
  只做三件事：解析、选档下载、看进度。样式交给宿主。
-->
<template>
  <section class="vdl-panel">
    <div class="vdl-row">
      <input v-model="url" placeholder="粘贴抖音 / B站 / 网易云链接" @keyup.enter="probe" />
      <button :disabled="busy || !url" @click="probe">{{ busy ? '解析中…' : '解析' }}</button>
    </div>

    <p v-if="error" class="vdl-error">[{{ error.code }}] {{ error.message }}</p>

    <article v-if="media" class="vdl-result">
      <h3>{{ media.title }}</h3>
      <p>{{ media.author }} · {{ media.platform }}</p>

      <label v-for="f in formats" :key="f.id" class="vdl-format">
        <input v-model="picked" type="radio" :value="f.id" />
        {{ f.label }} · {{ f.bytes ? (f.bytes / 1048576).toFixed(1) + ' MB' : '未知体积' }}
      </label>

      <button :disabled="!picked || busy" @click="download">
        下载{{ picked ? '（1 个档位）' : '' }}
      </button>
    </article>

    <ul class="vdl-jobs">
      <li v-for="job in jobs" :key="job.id">
        {{ job.title || job.url }} — {{ label(job.status) }} {{ job.percent }}%
        <a v-if="job.status === 'done'" :href="fileUrl(job.id)" target="_blank">取文件</a>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ baseUrl: string; token: string }>()

const url = ref('')
const busy = ref(false)
const error = ref<any>(null)
const media = ref<any>(null)
const formats = ref<any[]>([])
const picked = ref('')
const jobs = ref<any[]>([])
let source: EventSource | null = null

const headers = () => ({ 'Content-Type': 'application/json', 'X-VDL-Token': props.token })

async function call(path: string, body?: unknown) {
  const res = await fetch(`${props.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

async function probe() {
  busy.value = true
  error.value = null
  try {
    const data = await call('/api/probe', { url: url.value })
    if (!data.ok) {
      error.value = data.error
      media.value = null
      return
    }
    media.value = data.media
    formats.value = data.formats
    picked.value = (data.formats.find((f: any) => f.recommended) || {}).id || ''
  } finally {
    busy.value = false
  }
}

async function download() {
  busy.value = true
  try {
    const data = await call('/api/jobs', {
      url: media.value?.source_url || url.value,
      formatIds: [picked.value],
    })
    if (!data.ok) error.value = data.error
  } finally {
    busy.value = false
  }
}

function label(status: string) {
  return ({ queued: '排队', running: '下载中', done: '完成', failed: '失败' } as any)[status] || status
}

function fileUrl(id: string) {
  return `${props.baseUrl}/api/files/${id}?token=${encodeURIComponent(props.token)}`
}

onMounted(async () => {
  const list = await call('/api/jobs')
  if (list.ok) jobs.value = list.jobs
  source = new EventSource(`${props.baseUrl}/api/events?token=${encodeURIComponent(props.token)}`)
  source.onmessage = (ev) => {
    const data = JSON.parse(ev.data)
    if (data.type !== 'job') return
    const index = jobs.value.findIndex((j) => j.id === data.job.id)
    if (index >= 0) jobs.value[index] = data.job
    else jobs.value.unshift(data.job)
  }
})

onBeforeUnmount(() => source?.close())
</script>
