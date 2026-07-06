import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type { AnimationItem } from 'lottie-web'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
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

const FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.15/dist/esm'

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

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const ffmpegRef = useRef(new FFmpeg())
  const ffmpegLoadedRef = useRef(false)
  const exportCanvasHostRef = useRef<HTMLDivElement | null>(null)

  const readyCount = useMemo(() => assets.filter((asset) => asset.status === 'ready').length, [assets])
  const errorCount = useMemo(() => assets.filter((asset) => asset.status === 'error').length, [assets])

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
          const stats = getAssetStats(data)
          return {
            id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
            file,
            name: file.name,
            size: file.size,
            status: 'ready' as const,
            data,
            width: stats.width,
            height: stats.height,
            frameRate: stats.frameRate,
            frames: stats.frames,
            duration: stats.duration,
          } satisfies AssetRecord
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
        await ffmpeg.writeFile(frameName, await fetchFile(blob))
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
      setExportMessage(error instanceof Error ? error.message : 'MP4 export failed.')
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
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Bulk Lottie Viewer</p>
          <h1>Gallery view for batch checks</h1>
          <p className="lede">Load a pile of Lottie JSON files, scan them as cards, and keep the whole batch visible.</p>
        </div>

        <div className="toolbar">
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={handleInputChange}
          />
          <button type="button" className="button button-primary" onClick={() => inputRef.current?.click()}>
            Add files
          </button>
          <button type="button" className="button" onClick={handleClear} disabled={!assets.length}>
            Clear
          </button>
        </div>
      </header>

      <section className="upload-strip" aria-label="Upload area">
        <button
          type="button"
          className="upload-hero"
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
          <span className="upload-plus">+</span>
          <span className="upload-text">{loading ? 'Reading files' : dragging ? 'Drop to add' : 'Click or drop JSON files'}</span>
          <span className="upload-hint">Supports 50 files at once. Nested folders work too.</span>
        </button>

        <div className="upload-stats">
          <div>
            <span>Total</span>
            <strong>{totalCount}</strong>
          </div>
          <div>
            <span>Ready</span>
            <strong>{readyCount}</strong>
          </div>
          <div>
            <span>Errors</span>
            <strong>{errorCount}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong>{status}</strong>
          </div>
        </div>
      </section>

      <section className="gallery-toolbar">
        <div className="tabs" role="tablist" aria-label="Asset filters">
          <button type="button" className={`tab ${tab === 'all' ? 'is-active' : ''}`} onClick={() => setTab('all')}>
            All Assets <span>{assets.length}</span>
          </button>
          <button type="button" className={`tab ${tab === 'ready' ? 'is-active' : ''}`} onClick={() => setTab('ready')}>
            Lottie Animations <span>{readyCount}</span>
          </button>
          <button type="button" className={`tab ${tab === 'error' ? 'is-active' : ''}`} onClick={() => setTab('error')}>
            Errors <span>{errorCount}</span>
          </button>
        </div>

        <div className="filters">
          <label className="select-field">
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

          <label className="select-field">
            <span>Search</span>
            <input
              type="search"
              value={search}
              placeholder="Filter by name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
      </section>

      <main className="gallery-shell">
        {filteredAssets.length ? (
          <div className="card-grid" aria-label="Loaded Lottie assets">
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
                    {active ? <span className="card-chip">Selected</span> : null}
                  </div>
                  <div className="asset-meta">
                    <div className="asset-head">
                      <span className="asset-name">{asset.name}</span>
                    </div>
                    <div className="asset-footer">
                      <div className="author-pill">
                        <span className="author-avatar">{fileInitials(asset.name)}</span>
                        <span className="author-text">Local import</span>
                      </div>
                      <div className="asset-metric">
                        <span className={`asset-badge ${asset.status === 'ready' ? 'is-ready' : 'is-error'}`}>
                          {asset.status === 'ready' ? `${asset.frames}f` : 'Error'}
                        </span>
                        <span className="asset-foot">
                          {asset.status === 'ready' ? formatBytes(asset.size) : asset.error ?? 'Parse failed'}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="empty-state">
            <p>No files yet.</p>
            <p>Use the plus button or drop a folder of JSON files here.</p>
          </div>
        )}
      </main>

      {detailOpen && detailsAsset ? (
        <div className="detail-overlay" role="presentation" onClick={() => setDetailOpen(false)}>
          <aside
            className="detail-panel"
            aria-label="Selected asset details"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-head">
              <div>
                <p className="detail-kicker">Detail</p>
                <h2>{detailsAsset.name}</h2>
                <p className="detail-meta">
                  {detailsAsset.status === 'ready'
                    ? `${detailsAsset.width}x${detailsAsset.height} · ${detailsAsset.frames} frames · ${formatDuration(detailsAsset.duration ?? 0)}`
                    : detailsAsset.error ?? 'Parse failed'}
                </p>
              </div>

              <div className="detail-actions">
                <button type="button" className="button" onClick={() => setDetailOpen(false)}>
                  Close
                </button>
                <button type="button" className="button" onClick={() => downloadFile(detailsAsset.file)}>
                  Download JSON
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => exportSelectedMp4(detailsAsset)}
                  disabled={exporting}
                >
                  {exporting ? 'Exporting...' : 'Export MP4'}
                </button>
              </div>
            </div>

            <div className="detail-stage">
              <DetailPreview asset={detailsAsset} />
            </div>

            <div className="detail-export">
              <span>{exportMessage || 'MP4 export is ready for the selected animation.'}</span>
              {exporting ? <strong>{exportProgress}%</strong> : null}
            </div>

            <div className="detail-info">
              <div>
                <span>File</span>
                <strong>{detailsAsset.file.name}</strong>
              </div>
              <div>
                <span>Size</span>
                <strong>{formatBytes(detailsAsset.size)}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{detailsAsset.status}</strong>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      <div ref={exportCanvasHostRef} className="export-host" aria-hidden="true" />
    </div>
  )
}

export default App
