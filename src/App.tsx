import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type { AnimationItem } from 'lottie-web'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { fal } from '@fal-ai/client'
import './App.css'

type LottieData = Record<string, unknown> & {
  fr?: number
  ip?: number
  op?: number
  w?: number
  h?: number
}

type AssetStatus = 'ready' | 'error'
type AssetTab = 'all' | 'ready' | 'error'
type SortMode = 'featured' | 'newest' | 'oldest' | 'largest' | 'smallest' | 'name'
type AiProvider = 'fal' | 'wiro'

type AssetRecord = {
  id: string
  file: File
  name: string
  size: number
  status: AssetStatus
  data?: LottieData
  error?: string
  width?: number
  height?: number
  frameRate?: number
  frames?: number
  duration?: number
}

type LottieModule = typeof import('lottie-web')

type AiHistoryItem = {
  id: string
  provider: AiProvider
  prompt: string
  assetName?: string
  status: 'running' | 'success' | 'error'
  message: string
  createdAt: string
  logs: string[]
  rawOutput?: string
}

const FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}

function formatTimestamp(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = String(Math.floor(safe / 60)).padStart(2, '0')
  const secs = String(safe % 60).padStart(2, '0')
  return `${minutes}:${secs}`
}

function getAssetStats(data: LottieData) {
  const frameRate = Number(data.fr ?? 60) || 60
  const inPoint = Number(data.ip ?? 0)
  const outPoint = Number(data.op ?? inPoint + 1)
  const rawFrames = outPoint - inPoint
  const frames = Math.max(1, Math.round(rawFrames > 0 ? rawFrames : 1))
  const duration = frames / frameRate
  const width = Math.max(1, Math.round(Number(data.w ?? 0) || 0))
  const height = Math.max(1, Math.round(Number(data.h ?? 0) || 0))
  return { frameRate, frames, duration, width, height }
}

function downloadFile(file: File) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function fileInitials(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || 'LF'
}

function safeFileName(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

function makeLottieFile(name: string, data: LottieData) {
  return new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' })
}

function createAssetRecord(file: File, data: LottieData): AssetRecord {
  const stats = getAssetStats(data)
  return {
    id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
    file,
    name: file.name,
    size: file.size,
    status: 'ready',
    data,
    width: stats.width,
    height: stats.height,
    frameRate: stats.frameRate,
    frames: stats.frames,
    duration: stats.duration,
  }
}

function extractJsonFromText(text: string) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = (fenceMatch?.[1] ?? text).trim()
  return JSON.parse(raw)
}

function previewPayload(value: unknown) {
  if (typeof value === 'string') return value.slice(0, 5000)

  try {
    return JSON.stringify(value, null, 2).slice(0, 5000)
  } catch {
    return String(value).slice(0, 5000)
  }
}

function isLottieData(value: unknown): value is LottieData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      ('layers' in value || 'assets' in value) &&
      ('fr' in value || 'op' in value || 'w' in value || 'h' in value),
  )
}

function findLottieData(value: unknown): LottieData | null {
  if (isLottieData(value)) return value

  if (typeof value === 'string') {
    try {
      return findLottieData(extractJsonFromText(value))
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLottieData(item)
      if (found) return found
    }
    return null
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findLottieData(item)
      if (found) return found
    }
  }

  return null
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function waitForAnimationEvent(animation: AnimationItem, eventName: 'DOMLoaded' | 'complete') {
  return new Promise<void>((resolve) => {
    const handler = () => {
      animation.removeEventListener(eventName, handler)
      resolve()
    }

    animation.addEventListener(eventName, handler)
  })
}

async function readDroppedFiles(items: DataTransferItemList, files: FileList) {
  const itemArray = Array.from(items ?? [])

  if (
    itemArray.length > 0 &&
    itemArray.some((item) => typeof (item as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === 'function')
  ) {
    const collected: File[] = []

    const walkEntry = async (entry: any): Promise<void> => {
      if (!entry) return

      if (entry.isFile) {
        await new Promise<void>((resolve, reject) => {
          entry.file(
            (file: File) => {
              collected.push(file)
              resolve()
            },
            (error: unknown) => reject(error),
          )
        })
        return
      }

      if (entry.isDirectory) {
        const reader = entry.createReader()

        while (true) {
          const batch: any[] = await new Promise((resolve, reject) => {
            reader.readEntries(resolve, reject)
          })

          if (!batch.length) break

          await Promise.all(batch.map((child) => walkEntry(child)))
        }
      }
    }

    const entries = itemArray
      .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry?.())
      .filter(Boolean)

    await Promise.all(entries.map((entry) => walkEntry(entry)))
    return collected
  }

  return Array.from(files ?? [])
}

async function loadFfmpeg(ffmpeg: FFmpeg, loadedRef: { current: boolean }) {
  if (loadedRef.current) return

  ffmpeg.on('log', ({ message }) => {
    console.debug('[ffmpeg]', message)
  })

  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  })

  loadedRef.current = true
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result)
        return
      }
      reject(new Error('Canvas frame could not be captured.'))
    }, 'image/png')
  })

  return blob
}

function Thumbnail({ data, autoplay }: { data: LottieData; autoplay: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<AnimationItem | null>(null)
  const lottieRef = useRef<LottieModule | null>(null)

  useEffect(() => {
    const host = hostRef.current
    let cancelled = false

    if (!host) return

    const mount = async () => {
      const module = lottieRef.current ?? (await import('lottie-web'))
      if (cancelled || !hostRef.current) return

      lottieRef.current = module
      host.innerHTML = ''
      animationRef.current?.destroy()

      animationRef.current = module.default.loadAnimation({
        container: host,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        animationData: data,
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
          progressiveLoad: true,
        },
      })

      animationRef.current.goToAndStop(0, true)
    }

    void mount()

    return () => {
      cancelled = true
      animationRef.current?.destroy()
      animationRef.current = null
    }
  }, [data])

  useEffect(() => {
    const animation = animationRef.current
    if (!animation) return
    if (autoplay) {
      animation.goToAndPlay(0, true)
    } else {
      animation.goToAndStop(0, true)
    }
  }, [autoplay])

  return <div ref={hostRef} className="thumb-host" aria-hidden="true" />
}

function DetailPreview({ asset }: { asset: AssetRecord }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<AnimationItem | null>(null)
  const lottieRef = useRef<LottieModule | null>(null)

  useEffect(() => {
    const host = hostRef.current
    let cancelled = false

    if (!host || asset.status !== 'ready' || !asset.data) return

    const mount = async () => {
      const module = lottieRef.current ?? (await import('lottie-web'))
      if (cancelled || !hostRef.current) return

      lottieRef.current = module
      host.innerHTML = ''
      animationRef.current?.destroy()

      animationRef.current = module.default.loadAnimation({
        container: host,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: asset.data,
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
          progressiveLoad: true,
        },
      })
    }

    void mount()

    return () => {
      cancelled = true
      animationRef.current?.destroy()
      animationRef.current = null
    }
  }, [asset])

  return asset.status === 'ready' && asset.data ? (
    <div ref={hostRef} className="detail-preview" aria-hidden="true" />
  ) : (
    <div className="detail-empty">
      <strong>{asset.error ?? 'Preview unavailable'}</strong>
    </div>
  )
}

function App() {
  const [assets, setAssets] = useState<AssetRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('featured')
  const [tab, setTab] = useState<AssetTab>('all')
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('JSON dosyalarını bırak.')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportMessage, setExportMessage] = useState<string>('')
  const [exportUrl, setExportUrl] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [falKey, setFalKey] = useState(() => sessionStorage.getItem('bulk-lottie-viewer:fal-key') ?? '')
  const [wiroKey, setWiroKey] = useState(() => sessionStorage.getItem('bulk-lottie-viewer:wiro-key') ?? '')
  const [wiroModel, setWiroModel] = useState(() => sessionStorage.getItem('bulk-lottie-viewer:wiro-model') ?? 'openai/gpt-5.5')
  const [aiProvider, setAiProvider] = useState<AiProvider>('fal')
  const [aiPrompt, setAiPrompt] = useState('Make this animation cleaner, smoother, and more premium while keeping the same idea.')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState('AI edits create a new Lottie file in this browser session.')
  const [aiHistory, setAiHistory] = useState<AiHistoryItem[]>([])
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false)
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const ffmpegRef = useRef(new FFmpeg())
  const ffmpegLoadedRef = useRef(false)
  const exportCanvasHostRef = useRef<HTMLDivElement | null>(null)

  const readyCount = useMemo(() => assets.filter((asset) => asset.status === 'ready').length, [assets])
  const errorCount = useMemo(() => assets.filter((asset) => asset.status === 'error').length, [assets])

  useEffect(() => {
    if (falKey) {
      sessionStorage.setItem('bulk-lottie-viewer:fal-key', falKey)
    } else {
      sessionStorage.removeItem('bulk-lottie-viewer:fal-key')
    }
  }, [falKey])

  useEffect(() => {
    if (wiroKey) {
      sessionStorage.setItem('bulk-lottie-viewer:wiro-key', wiroKey)
    } else {
      sessionStorage.removeItem('bulk-lottie-viewer:wiro-key')
    }
  }, [wiroKey])

  useEffect(() => {
    if (wiroModel) {
      sessionStorage.setItem('bulk-lottie-viewer:wiro-model', wiroModel)
    } else {
      sessionStorage.removeItem('bulk-lottie-viewer:wiro-model')
    }
  }, [wiroModel])

  useEffect(() => {
    if (!activeId && assets.length) {
      setActiveId(assets[0].id)
    }
  }, [activeId, assets])

  const filteredAssets = useMemo(() => {
    const query = search.trim().toLowerCase()

    let next = assets.filter((asset) => {
      if (tab === 'ready') return asset.status === 'ready'
      if (tab === 'error') return asset.status === 'error'
      return true
    })

    if (query) {
      next = next.filter((asset) => asset.name.toLowerCase().includes(query))
    }

    const sorters: Record<SortMode, (a: AssetRecord, b: AssetRecord) => number> = {
      featured: (a, b) => {
        if (a.status !== b.status) return a.status === 'ready' ? -1 : 1
        return b.size - a.size
      },
      newest: (a, b) => b.id.localeCompare(a.id),
      oldest: (a, b) => a.id.localeCompare(b.id),
      largest: (a, b) => b.size - a.size,
      smallest: (a, b) => a.size - b.size,
      name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    }

    return [...next].sort(sorters[sortMode])
  }, [assets, search, sortMode, tab])

  async function ingestFiles(files: File[]) {
    const jsonFiles = files.filter((file) => {
      const lower = file.name.toLowerCase()
      return lower.endsWith('.json') || file.type === 'application/json'
    })

    if (!jsonFiles.length) {
      setStatus('Sadece JSON Lottie dosyaları destekleniyor.')
      return
    }

    setLoading(true)

    try {
      const settled = await Promise.allSettled(
        jsonFiles.map(async (file) => {
          const raw = await file.text()
          const data = JSON.parse(raw) as LottieData
          return createAssetRecord(file, data)
        }),
      )

      const parsed = settled.map((result, index) => {
        const file = jsonFiles[index]
        if (result.status === 'fulfilled') return result.value
        return {
          id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
          file,
          name: file.name,
          size: file.size,
          status: 'error' as const,
          error: result.reason instanceof Error ? result.reason.message : 'Dosya okunamadı.',
        } satisfies AssetRecord
      })

      const addedReady = parsed.filter((asset) => asset.status === 'ready').length
      const addedError = parsed.filter((asset) => asset.status === 'error').length

      setAssets((current) => [...current, ...parsed])
      setActiveId((current) => current ?? parsed[0]?.id ?? null)
      setStatus(
        addedError
          ? `${addedReady} hazır, ${addedError} hatalı dosya eklendi.`
          : `${addedReady} dosya eklendi.`,
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    try {
      await ingestFiles(files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Dosyalar okunamadı.')
      setLoading(false)
    }
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)

    try {
      const files = await readDroppedFiles(event.dataTransfer.items, event.dataTransfer.files)
      await ingestFiles(files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Bırakılan dosyalar okunamadı.')
      setLoading(false)
    }
  }

  function handleClear() {
    setAssets([])
    setActiveId(null)
    setSearch('')
    setSortMode('featured')
    setTab('all')
    setHoveredId(null)
    setDetailOpen(false)
    setStatus('Liste temizlendi.')
  }

  const activeAsset = assets.find((asset) => asset.id === activeId) ?? filteredAssets[0] ?? null
  const totalCount = assets.length
  const detailsAsset = activeAsset ?? filteredAssets[0] ?? null
  const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0)
  const activeHistory = aiHistory.find((item) => item.id === activeHistoryId) ?? aiHistory[0] ?? null

  useEffect(() => {
    if (!detailOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [detailOpen])

  useEffect(() => {
    return () => {
      if (exportUrl) {
        URL.revokeObjectURL(exportUrl)
      }
    }
  }, [exportUrl])

  async function exportSelectedMp4(asset: AssetRecord) {
    if (asset.status !== 'ready' || !asset.data) {
      setExportMessage('Only ready Lottie JSON files can be exported.')
      return
    }

    const host = exportCanvasHostRef.current
    if (!host) {
      setExportMessage('Export surface is not ready.')
      return
    }

    setExporting(true)
    setExportProgress(0)
    setExportMessage('Loading ffmpeg...')

    const ffmpeg = ffmpegRef.current
    let frameAnimation: AnimationItem | null = null
    let previewModule: LottieModule | null = null
    const fileStem = safeFileName(asset.name).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'lottie'
    const runId = `${Date.now()}-${asset.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`

    try {
      await loadFfmpeg(ffmpeg, ffmpegLoadedRef)
      setExportMessage('Rendering frames...')

      previewModule = await import('lottie-web')
      host.innerHTML = ''
      frameAnimation = previewModule.default.loadAnimation({
        container: host,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData: asset.data,
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
          clearCanvas: true,
          progressiveLoad: true,
        },
      })

      await waitForAnimationEvent(frameAnimation, 'DOMLoaded')

      const totalFrames = Math.max(1, asset.frames ?? 1)
      const fps = Math.max(1, Math.round(asset.frameRate ?? 30))

      for (let index = 0; index < totalFrames; index += 1) {
        frameAnimation.goToAndStop(index, true)
        await nextFrame()

        const canvas = host.querySelector('canvas')
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Canvas renderer did not initialize.')
        }

        const blob = await canvasToBlob(canvas)
        const frameName = `${fileStem}-${runId}-${String(index).padStart(5, '0')}.png`
        await ffmpeg.writeFile(frameName, new Uint8Array(await blob.arrayBuffer()))
        setExportProgress(Math.round(((index + 1) / totalFrames) * 100))
      }

      setExportMessage('Encoding MP4...')
      const inputPattern = `${fileStem}-${runId}-%05d.png`
      const outputName = `${fileStem}-${runId}.mp4`
      await ffmpeg.exec([
        '-framerate',
        String(fps),
        '-i',
        inputPattern,
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outputName,
      ])

      const output = await ffmpeg.readFile(outputName)
      const mp4Bytes =
        output instanceof Uint8Array
          ? output
          : typeof output === 'string'
            ? new TextEncoder().encode(output)
            : new Uint8Array(output as ArrayBuffer)
      const mp4Buffer = Uint8Array.from(mp4Bytes).buffer
      const mp4Blob = new Blob([mp4Buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(mp4Blob)

      if (exportUrl) {
        URL.revokeObjectURL(exportUrl)
      }
      setExportUrl(url)

      const downloadLink = document.createElement('a')
      downloadLink.href = url
      downloadLink.download = `${fileStem}.mp4`
      downloadLink.rel = 'noopener'
      document.body.appendChild(downloadLink)
      downloadLink.click()
      downloadLink.remove()

      setExportMessage('MP4 ready.')
      setStatus('MP4 exported.')
      setDetailOpen(true)
    } catch (error) {
      console.error(error)
      setExportMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      setStatus('MP4 export failed.')
    } finally {
      if (frameAnimation) {
        frameAnimation.destroy()
      }
      if (host) {
        host.innerHTML = ''
      }
      setExporting(false)
      setExportProgress(0)
    }
  }

  function addAiHistory(item: Omit<AiHistoryItem, 'id' | 'createdAt' | 'logs'> & { logs?: string[] }) {
    const entry = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toLocaleTimeString(),
      logs: item.logs ?? [],
    }

    setAiHistory((current) => [entry, ...current].slice(0, 12))
    setActiveHistoryId(entry.id)
    setHistoryPanelOpen(true)
    return entry.id
  }

  function updateAiHistory(id: string, patch: Partial<Omit<AiHistoryItem, 'id' | 'createdAt'>>) {
    setAiHistory((current) =>
      current.map((item) => {
        if (item.id !== id) return item
        return {
          ...item,
          ...patch,
          logs: patch.logs ?? item.logs,
        }
      }),
    )
    setActiveHistoryId(id)
  }

  function appendAiHistoryLog(id: string, log: string) {
    setAiHistory((current) =>
      current.map((item) => {
        if (item.id !== id) return item
        return {
          ...item,
          logs: [...item.logs, log].slice(-24),
        }
      }),
    )
    setActiveHistoryId(id)
  }

  function addGeneratedAsset(name: string, data: LottieData) {
    const file = makeLottieFile(name, data)
    const asset = createAssetRecord(file, data)

    setAssets((current) => [asset, ...current])
    setActiveId(asset.id)
    setStatus(`${name} AI ile eklendi.`)
    setAiMessage(`${name} ready.`)
  }

  async function runFalOmnilottie(prompt: string, historyId: string) {
    if (!falKey.trim()) {
      throw new Error('Fal API key is missing.')
    }

    fal.config({ credentials: falKey.trim() })
    updateAiHistory(historyId, {
      message: 'Submitted to fal.ai Omnilottie.',
      logs: ['Submitted to fal.ai Omnilottie.'],
    })
    const result = await fal.subscribe('fal-ai/omnilottie', {
      input: {
        prompt,
        max_tokens: 4096,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_PROGRESS') {
          const latestLog = update.logs?.at(-1)?.message
          setAiMessage(latestLog ?? 'Fal is generating Lottie JSON...')
          if (latestLog) {
            updateAiHistory(historyId, {
              message: latestLog,
            })
            appendAiHistoryLog(historyId, latestLog)
          }
        }
      },
    })

    const data = result.data as { lottie_file?: { url?: string }; lottie?: unknown; output?: unknown }
    updateAiHistory(historyId, {
      message: 'Fal returned a result. Fetching generated JSON...',
      rawOutput: previewPayload(data),
      logs: ['Fal result received.', data.lottie_file?.url ? `Result file: ${data.lottie_file.url}` : 'Inline payload received.'],
    })
    if (data.lottie_file?.url) {
      const response = await fetch(data.lottie_file.url)
      if (!response.ok) throw new Error(`Fal result could not be fetched: ${response.status}`)
      const generated = await response.json()
      const lottie = findLottieData(generated)
      if (lottie) {
        updateAiHistory(historyId, {
          rawOutput: previewPayload(generated),
          logs: ['Downloaded generated JSON.', 'Valid Lottie JSON found.'],
        })
        return lottie
      }
    }

    const direct = findLottieData(data)
    if (direct) return direct

    throw new Error('Fal response did not include valid Lottie JSON.')
  }

  async function runWiroEdit(asset: AssetRecord, prompt: string, historyId: string) {
    if (!wiroKey.trim()) {
      throw new Error('Wiro API key is missing.')
    }

    if (!wiroModel.trim()) {
      throw new Error('Wiro model slug is missing.')
    }

    if (asset.status !== 'ready' || !asset.data) {
      throw new Error('Select a valid Lottie before using Wiro edit.')
    }

    const request = {
      prompt: [
        'You are editing a Lottie animation JSON.',
        'Return only valid Lottie JSON. No markdown, no explanations.',
        `User edit request: ${prompt}`,
        `Current Lottie JSON: ${JSON.stringify(asset.data)}`,
      ].join('\n\n'),
    }
    updateAiHistory(historyId, {
      message: `Submitted to Wiro: ${wiroModel.trim()}`,
      logs: [`Endpoint model: ${wiroModel.trim()}`, 'Waiting for Wiro response...'],
    })

    const modelPath = wiroModel.trim().split('/').map(encodeURIComponent).join('/')
    const isLocalDev = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    const endpoint = isLocalDev
      ? `/api/wiro/v1/Run/${modelPath}`
      : `https://api.wiro.ai/v1/Run/${modelPath}`

    const trimmedWiroKey = wiroKey.trim()
    const authHeaders: Record<string, string> = trimmedWiroKey.includes(':')
      ? { Authorization: `Bearer ${trimmedWiroKey}` }
      : { 'x-api-key': trimmedWiroKey }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const errorText = await response.text()
      const authHint =
        response.status === 401
          ? ' Use a plain API key, or API_KEY:API_SECRET if your Wiro project uses signature auth.'
          : ''
      throw new Error(`Wiro request failed: ${response.status} ${errorText.slice(0, 180)}${authHint}`)
    }

    const payload = await response.json()
    updateAiHistory(historyId, {
      message: 'Wiro returned a response.',
      rawOutput: previewPayload(payload),
      logs: ['Wiro response received.', 'Checking for Lottie JSON...'],
    })
    const lottie = findLottieData(payload)
    if (!lottie) {
      throw new Error('Wiro response did not include valid Lottie JSON. Raw response is visible in History.')
    }

    return lottie
  }

  async function runAiEdit(asset: AssetRecord | null) {
    const prompt = aiPrompt.trim()
    if (!prompt) {
      setAiMessage('Write an edit prompt first.')
      return
    }

    setAiBusy(true)
    setAiMessage(aiProvider === 'fal' ? 'Fal Omnilottie is generating...' : 'Wiro is editing JSON...')
    const historyId = addAiHistory({
      provider: aiProvider,
      prompt,
      status: 'running',
      message: aiProvider === 'fal' ? 'Starting fal.ai Omnilottie request...' : 'Starting Wiro request...',
      logs: ['Request created in browser session.'],
    })

    try {
      const sourceName = asset?.name ? safeFileName(asset.name) : 'prompt'
      const strongerPrompt =
        aiProvider === 'fal'
          ? [
              prompt,
              'Create a polished, production-ready Lottie animation.',
              'Use clean vector shapes, smooth timing, readable composition, and avoid noisy decorative clutter.',
              'Prefer simple premium motion over complex messy scenes.',
              asset?.data ? `Reference the current Lottie concept and filename: ${sourceName}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          : prompt
      const data =
        aiProvider === 'fal'
          ? await runFalOmnilottie(strongerPrompt, historyId)
          : await runWiroEdit(asset as AssetRecord, prompt, historyId)
      const name = `${sourceName}-${aiProvider}-edit-${Date.now()}.json`
      addGeneratedAsset(name, data)
      updateAiHistory(historyId, {
        assetName: name,
        status: 'success',
        message: 'New Lottie added to the batch.',
        logs: ['Valid Lottie JSON parsed.', `Added asset: ${name}`],
      })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message =
        aiProvider === 'wiro' && rawMessage === 'Failed to fetch'
          ? 'Wiro could not be reached from this browser. Local dev now uses a proxy; refresh localhost and try again. On GitHub Pages, Wiro needs CORS support or a proxy URL.'
          : rawMessage
      setAiMessage(message)
      updateAiHistory(historyId, {
        status: 'error',
        message,
        logs: ['Request failed.', message],
      })
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div
      className={`app-shell ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={handleInputChange}
      />

      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>Bulk Lottie Viewer</h1>
        </div>

        <div className="sidebar-tools">
          <button type="button" className="primary-action" onClick={() => inputRef.current?.click()}>
            <span>+</span>
            Import Folder
          </button>

          <label className="search-field">
            <input
              type="search"
              value={search}
              placeholder="Search files..."
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <nav className="sidebar-nav" aria-label="Asset filters">
          <button type="button" className={`nav-item ${tab === 'all' ? 'is-active' : ''}`} onClick={() => setTab('all')}>
            <span>All Files</span>
            <strong>{assets.length}</strong>
          </button>
          <button type="button" className={`nav-item ${tab === 'ready' ? 'is-active' : ''}`} onClick={() => setTab('ready')}>
            <span>Optimized</span>
            <strong>{readyCount}</strong>
          </button>
          <button type="button" className={`nav-item ${tab === 'error' ? 'is-active' : ''}`} onClick={() => setTab('error')}>
            <span>Warnings</span>
            <strong>{errorCount}</strong>
          </button>
        </nav>

        <div className="sidebar-section">
          <span className="section-label">Files</span>
          <div className="asset-list">
            {filteredAssets.length ? (
              filteredAssets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`list-row ${asset.id === activeAsset?.id ? 'is-active' : ''}`}
                  onClick={() => {
                    setActiveId(asset.id)
                    setDetailOpen(true)
                  }}
                >
                  <div className="list-row-copy">
                    <span className="list-row-name">{asset.name}</span>
                    <span className="list-row-meta">{formatBytes(asset.size)}</span>
                  </div>
                  <span className={`list-row-state ${asset.status}`}>{asset.status === 'ready' ? 'Ready' : 'Issue'}</span>
                </button>
              ))
            ) : (
              <div className="sidebar-empty">No files loaded.</div>
            )}
          </div>
        </div>

        <div className="sidebar-ai">
          {settingsOpen ? (
            <section className="settings-panel" aria-label="AI API settings">
              <div className="settings-head">
                <div>
                  <span className="section-label">AI Keys</span>
                  <strong>Session only</strong>
                </div>
                <button type="button" className="icon-button compact-button" onClick={() => setSettingsOpen(false)}>
                  Close
                </button>
              </div>

              <label className="settings-field">
                <span>fal.ai API key</span>
                <input
                  type="password"
                  value={falKey}
                  placeholder="fal key"
                  onChange={(event) => setFalKey(event.target.value)}
                />
              </label>

            <label className="settings-field">
                <span>Wiro API key or key:secret</span>
                <input
                  type="password"
                  value={wiroKey}
                  placeholder="wiro key or key:secret"
                  onChange={(event) => setWiroKey(event.target.value)}
                />
              </label>

              <label className="settings-field">
                <span>Wiro model slug</span>
                <input
                  type="text"
                  value={wiroModel}
                  placeholder="openai/gpt-5.5"
                  onChange={(event) => setWiroModel(event.target.value)}
                />
              </label>

              <p className="privacy-note">
                No files or keys are stored by us. Keys live only in this browser session.
              </p>
            </section>
          ) : null}
          <button type="button" className="sidebar-ai-button" onClick={() => setSettingsOpen((current) => !current)}>
            <span>AI</span>
            <strong>{falKey || wiroKey ? 'Connected' : 'Add keys'}</strong>
          </button>
          <button type="button" className="sidebar-history-button" onClick={() => setHistoryPanelOpen(true)}>
            <span>History</span>
            <strong>{aiHistory.length}</strong>
          </button>
        </div>

        <div className="sidebar-footer">
          <span>v2.4.0 Batch Mode</span>
          <button type="button" className="ghost-action" onClick={handleClear} disabled={!assets.length}>
            Clear
          </button>
        </div>
      </aside>

      <main className="main-shell">
        <header className="main-header">
          <div className="main-title">
            <span className="kicker">Lottie Batch Viewer</span>
            <span className="subtitle">{totalCount} animations loaded</span>
          </div>

          <div className="header-controls">
            <label className="sort-control">
              <span>Sort</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option value="featured">Featured</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="largest">Largest</option>
                <option value="smallest">Smallest</option>
                <option value="name">Name</option>
              </select>
            </label>
            <div className="stat-pill">{formatBytes(totalSize)}</div>
            <div className="stat-pill">{status}</div>
          </div>
        </header>

        <section className="gallery-area">
          <div className="card-grid" aria-label="Loaded Lottie assets">
            <button
              type="button"
              className="upload-card"
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
            >
              <span className="upload-card-plus">+</span>
              <strong>{loading ? 'Reading files...' : dragging ? 'Drop JSON files' : 'Click or drop JSON files'}</strong>
              <span>Supports 50 files at once. Nested folders work too.</span>
            </button>

            {filteredAssets.map((asset) => {
              const active = asset.id === activeAsset?.id
              return (
                <button
                  type="button"
                  key={asset.id}
                  className={`asset-card ${active ? 'is-active' : ''}`}
                  onClick={() => {
                    setActiveId(asset.id)
                    setDetailOpen(true)
                  }}
                  onMouseEnter={() => setHoveredId(asset.id)}
                  onMouseLeave={() => setHoveredId((current) => (current === asset.id ? null : current))}
                >
                  <div className="asset-preview">
                    {asset.status === 'ready' && asset.data ? (
                      <Thumbnail data={asset.data} autoplay={hoveredId === asset.id} />
                    ) : (
                      <div className="error-preview">
                        <span>!</span>
                        <strong>Invalid JSON</strong>
                      </div>
                    )}
                    <div className="preview-overlay">
                      <span>Inspect</span>
                    </div>
                  </div>

                  <div className="asset-meta">
                    <div className="asset-head">
                      <span className="asset-name">{asset.name}</span>
                      <span className={`asset-dot ${asset.status}`} />
                    </div>
                    <div className="asset-footer">
                      <div className="author-pill">
                        <span className="author-avatar">{fileInitials(asset.name)}</span>
                        <span className="author-text">Local import</span>
                      </div>
                      <div className="asset-metric">
                        <span>{formatBytes(asset.size)}</span>
                        <span>
                          {asset.status === 'ready'
                            ? `${formatDuration(asset.duration ?? 0)} @ ${Math.round(asset.frameRate ?? 0)}fps`
                            : 'Parse failed'}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <footer className="status-bar">
          <div className="status-group">
            <span className="status-live">Ready</span>
            <span>Files: {totalCount}</span>
            <span>Ready: {readyCount}</span>
            <span>Warnings: {errorCount}</span>
          </div>
          <div className="status-group">
            <span>{status}</span>
          </div>
          <div className="status-group credit-group">
            <span>Made with &lt;3 by hasaneyldrm</span>
            <a href="https://github.com/hasaneyldrm/lottie-viewer" target="_blank" rel="noreferrer">
              Open source
            </a>
          </div>
        </footer>
      </main>

      {detailOpen && detailsAsset ? (
        <div className="detail-overlay" role="presentation" onClick={() => setDetailOpen(false)}>
          <section className="detail-modal" aria-label="Selected asset details" onClick={(event) => event.stopPropagation()}>
            <header className="detail-modal-head">
              <div>
                <span className="kicker">Inspecting</span>
                <h2>{detailsAsset.name}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setDetailOpen(false)}>
                Close
              </button>
            </header>

            <div className="detail-modal-body">
              <div className="detail-stage-panel">
                <div className="detail-stage">
                  <div className="detail-stage-frame">
                    <DetailPreview asset={detailsAsset} />
                  </div>
                </div>

                <div className="playback-bar">
                  <button type="button" className="play-chip">
                    Preview
                  </button>
                  <div className="timeline-block">
                    <div className="timeline-meta">
                      <span>00:00</span>
                      <span>{formatTimestamp(detailsAsset.duration ?? 0)}</span>
                    </div>
                    <div className="timeline-track">
                      <span style={{ width: exporting ? `${exportProgress}%` : '38%' }} />
                    </div>
                  </div>
                </div>
              </div>

              <aside className="detail-inspector">
                <div className="detail-tabs">
                  <button type="button" className="detail-tab is-active">
                    File Details
                  </button>
                  <button type="button" className="detail-tab">
                    Layers
                  </button>
                </div>

                <div className="detail-section">
                  <span className="section-label">Core Metadata</span>
                  <div className="spec-grid">
                    <div>
                      <span>Dimensions</span>
                      <strong>
                        {detailsAsset.width && detailsAsset.height ? `${detailsAsset.width} × ${detailsAsset.height}` : '-'}
                      </strong>
                    </div>
                    <div>
                      <span>Duration</span>
                      <strong>{formatDuration(detailsAsset.duration ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Total Frames</span>
                      <strong>{detailsAsset.frames ?? '-'}</strong>
                    </div>
                    <div>
                      <span>Frame Rate</span>
                      <strong>{detailsAsset.frameRate ? `${Math.round(detailsAsset.frameRate)} fps` : '-'}</strong>
                    </div>
                  </div>
                </div>

                <div className="detail-section">
                  <span className="section-label">Health Check</span>
                  <div className="health-list">
                    <div className="health-row">
                      <span>Optimization</span>
                      <strong className={detailsAsset.status === 'ready' ? 'ok' : 'warn'}>
                        {detailsAsset.status === 'ready' ? 'READY' : 'ISSUE'}
                      </strong>
                    </div>
                    <div className="health-row">
                      <span>Export</span>
                      <strong className={exportMessage && exportMessage.includes('failed') ? 'warn' : 'ok'}>
                        {exporting ? `${exportProgress}%` : exportMessage || 'IDLE'}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="detail-section">
                  <span className="section-label">Actions</span>
                  <div className="detail-actions-stack">
                    <button type="button" className="secondary-action" onClick={() => downloadFile(detailsAsset.file)}>
                      Download JSON
                    </button>
                    <button
                      type="button"
                      className="primary-action modal-action"
                      onClick={() => exportSelectedMp4(detailsAsset)}
                      disabled={exporting}
                    >
                      {exporting ? 'Exporting...' : 'Export MP4'}
                    </button>
                  </div>
                </div>

                <div className="detail-section ai-section">
                  <span className="section-label">AI Edit</span>
                  <div className="provider-toggle" role="tablist" aria-label="AI provider">
                    <button
                      type="button"
                      className={aiProvider === 'fal' ? 'is-active' : ''}
                      onClick={() => setAiProvider('fal')}
                    >
                      fal.ai
                    </button>
                    <button
                      type="button"
                      className={aiProvider === 'wiro' ? 'is-active' : ''}
                      onClick={() => setAiProvider('wiro')}
                    >
                      Wiro
                    </button>
                  </div>
                  <textarea
                    className="ai-prompt"
                    value={aiPrompt}
                    onChange={(event) => setAiPrompt(event.target.value)}
                    placeholder="Tell AI what to change in this Lottie..."
                    rows={5}
                  />
                  <button
                    type="button"
                    className="primary-action modal-action"
                    onClick={() => runAiEdit(detailsAsset)}
                    disabled={aiBusy}
                  >
                    {aiBusy ? 'Editing...' : aiProvider === 'fal' ? 'Generate Lottie' : 'Edit with Wiro'}
                  </button>
                  <p className="privacy-note">
                    No data is stored by this app. Keys stay in sessionStorage. AI requests are sent only when you run an edit.
                  </p>
                  <p className="ai-message">{aiMessage}</p>
                </div>

                <div className="detail-section">
                  <span className="section-label">History</span>
                  <div className="ai-history">
                    {aiHistory.length ? (
                      aiHistory.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`history-row ${item.status}`}
                          onClick={() => {
                            setActiveHistoryId(item.id)
                            setHistoryPanelOpen(true)
                          }}
                        >
                          <span>{item.assetName ?? item.message}</span>
                          <small>
                            {item.provider} · {item.createdAt}
                          </small>
                        </button>
                      ))
                    ) : (
                      <p className="history-empty">No AI edits yet.</p>
                    )}
                  </div>
                </div>
              </aside>
            </div>
          </section>
        </div>
      ) : null}

      {historyPanelOpen ? (
        <aside className="history-drawer" aria-label="AI history">
          <header className="history-drawer-head">
            <div>
              <span className="section-label">AI Activity</span>
              <strong>{aiHistory.length} runs</strong>
            </div>
            <button type="button" className="icon-button compact-button" onClick={() => setHistoryPanelOpen(false)}>
              Close
            </button>
          </header>

          <div className="history-drawer-list">
            {aiHistory.length ? (
              aiHistory.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`history-row ${item.status} ${item.id === activeHistory?.id ? 'is-active' : ''}`}
                  onClick={() => setActiveHistoryId(item.id)}
                >
                  <span>{item.assetName ?? item.message}</span>
                  <small>
                    {item.provider} · {item.status} · {item.createdAt}
                  </small>
                </button>
              ))
            ) : (
              <p className="history-empty">No AI edits yet.</p>
            )}
          </div>

          {activeHistory ? (
            <div className="history-detail">
              <span className={`history-status ${activeHistory.status}`}>{activeHistory.status}</span>
              <h3>{activeHistory.assetName ?? 'AI run failed'}</h3>
              <p>{activeHistory.message}</p>
              <label>
                <span>Prompt</span>
                <textarea value={activeHistory.prompt} readOnly rows={6} />
              </label>
              <div className="history-log-block">
                <span>Logs</span>
                {activeHistory.logs.length ? (
                  <ol>
                    {activeHistory.logs.map((log, index) => (
                      <li key={`${activeHistory.id}-${index}`}>{log}</li>
                    ))}
                  </ol>
                ) : (
                  <p>No logs yet.</p>
                )}
              </div>
              {activeHistory.rawOutput ? (
                <label>
                  <span>Raw output</span>
                  <textarea value={activeHistory.rawOutput} readOnly rows={8} />
                </label>
              ) : null}
              {activeHistory.assetName ? (
                <button
                  type="button"
                  className="primary-action modal-action"
                  onClick={() => {
                    const found = assets.find((asset) => asset.name === activeHistory.assetName)
                    if (!found) return
                    setActiveId(found.id)
                    setDetailOpen(true)
                  }}
                >
                  Open generated Lottie
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>
      ) : null}

      <div ref={exportCanvasHostRef} className="export-host" aria-hidden="true" />
    </div>
  )
}

export default App
