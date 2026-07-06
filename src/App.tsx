import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import type { AnimationItem } from 'lottie-web'
import './App.css'

type LottieData = Record<string, unknown> & {
  fr?: number
  ip?: number
  op?: number
  w?: number
  h?: number
}

type AnimationAsset = {
  id: string
  file: File
  name: string
  size: number
  data: LottieData
  width: number
  height: number
  frameRate: number
  frames: number
  duration: number
}

type LottieModule = typeof import('lottie-web')

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
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 sn'
  if (seconds < 10) return `${seconds.toFixed(1)} sn`
  return `${Math.round(seconds)} sn`
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

function App() {
  const [assets, setAssets] = useState<AnimationAsset[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [frame, setFrame] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState('JSON dosyalarını bırak.')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<AnimationItem | null>(null)
  const lottieModuleRef = useRef<LottieModule | null>(null)

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedId) ?? assets[0] ?? null,
    [assets, selectedId],
  )

  const filteredAssets = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return assets
    return assets.filter((asset) => asset.name.toLowerCase().includes(query))
  }, [assets, search])

  useEffect(() => {
    if (!selectedId && assets.length) {
      setSelectedId(assets[0].id)
    }
  }, [assets, selectedId])

  useEffect(() => {
    const animation = animationRef.current
    if (!animation) return
    animation.setSpeed(speed)
  }, [speed])

  useEffect(() => {
    const animation = animationRef.current
    if (!animation) return
    if (playing) {
      animation.play()
    } else {
      animation.pause()
    }
  }, [playing, selectedAsset?.id])

  useEffect(() => {
    const animation = animationRef.current
    if (!animation || playing) return
    animation.goToAndStop(frame, true)
  }, [frame, playing])

  useEffect(() => {
    const container = previewRef.current
    const asset = selectedAsset
    let cancelled = false
    let localAnimation: AnimationItem | null = null

    if (!container || !asset) {
      if (previewRef.current) {
        previewRef.current.innerHTML = ''
      }
      animationRef.current?.destroy()
      animationRef.current = null
      return
    }

    const mountAnimation = async () => {
      const module = lottieModuleRef.current ?? (await import('lottie-web'))
      if (cancelled) return

      lottieModuleRef.current = module
      container.innerHTML = ''
      animationRef.current?.destroy()

      localAnimation = module.default.loadAnimation({
        container,
        renderer: 'svg',
        loop: true,
        autoplay: playing,
        animationData: asset.data,
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
          progressiveLoad: true,
        },
      })

      const handleEnterFrame = () => {
        setFrame(localAnimation?.currentFrame ?? 0)
      }

      localAnimation.setSpeed(speed)
      localAnimation.addEventListener('enterFrame', handleEnterFrame)

      if (!playing) {
        localAnimation.goToAndStop(frame, true)
      }

      animationRef.current = localAnimation
    }

    void mountAnimation()

    return () => {
      cancelled = true
      if (localAnimation) {
        localAnimation.destroy()
        if (animationRef.current === localAnimation) {
          animationRef.current = null
        }
      }
    }
  }, [selectedAsset])

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
            data,
            width: stats.width,
            height: stats.height,
            frameRate: stats.frameRate,
            frames: stats.frames,
            duration: stats.duration,
          } satisfies AnimationAsset
        }),
      )

      const parsed = settled
        .filter((result): result is PromiseFulfilledResult<AnimationAsset> => result.status === 'fulfilled')
        .map((result) => result.value)

      const rejected = settled.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )

      if (!parsed.length && rejected.length) {
        throw rejected[0]?.reason ?? new Error('Dosyalar okunamadı.')
      }

      setAssets((current) => [...current, ...parsed])
      setSelectedId((current) => current ?? parsed[0]?.id ?? null)
      setPlaying(true)
      setFrame(0)
      setStatus(
        rejected.length
          ? `${parsed.length} dosya yüklendi, ${rejected.length} dosya atlandı.`
          : `${parsed.length} dosya yüklendi. Toplam ${assets.length + parsed.length} adet.`,
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

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
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
    animationRef.current?.destroy()
    animationRef.current = null
    setAssets([])
    setSelectedId(null)
    setSearch('')
    setPlaying(false)
    setFrame(0)
    setStatus('Liste temizlendi.')
    if (previewRef.current) {
      previewRef.current.innerHTML = ''
    }
  }

  const visibleCount = filteredAssets.length

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
        <div>
          <p className="eyebrow">Bulk Lottie Viewer</p>
          <h1>Bulk JSON önizleyici</h1>
          <p className="lede">
            Toplu JSON dosyalarını tek ekranda listele, seçili olanı sağdan incele.
          </p>
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
            Dosya seç
          </button>
          <button type="button" className="button" onClick={handleClear} disabled={!assets.length}>
            Temizle
          </button>
        </div>
      </header>

      <section
        className={`dropzone ${loading ? 'is-loading' : ''}`}
        aria-label="Lottie yükleme alanı"
      >
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
          <span className="upload-text">
            {loading ? 'Dosyalar okunuyor' : dragging ? 'Bırak ve yükle' : 'Dosya ekle'}
          </span>
          <span className="upload-hint">
            Tıkla, 50 tane JSON seç ya da sürükleyip bırak.
          </span>
        </button>

        <div className="stats">
          <div>
            <span>Yüklenen</span>
            <strong>{assets.length}</strong>
          </div>
          <div>
            <span>Görünür</span>
            <strong>{visibleCount}</strong>
          </div>
          <div>
            <span>Durum</span>
            <strong>{status}</strong>
          </div>
        </div>
      </section>

      <main className="workspace">
        <aside className="sidebar">
          <div className="panel-head">
            <div>
              <p className="panel-label">Toplu liste</p>
              <h2>{assets.length ? `${assets.length} öğe` : 'Boş'}</h2>
            </div>
            <label className="search">
              <span>Arama</span>
              <input
                type="search"
                value={search}
                placeholder="Dosya adı"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          <div className="file-list" role="list" aria-label="Yüklenen Lottie dosyaları">
            {filteredAssets.length ? (
              filteredAssets.map((asset) => {
                const active = asset.id === selectedAsset?.id
                return (
                  <button
                    type="button"
                    key={asset.id}
                    className={`file-row ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedId(asset.id)
                      setFrame(0)
                    }}
                  >
                    <span className="file-row-name">{asset.name}</span>
                    <span className="file-row-meta">
                      {formatBytes(asset.size)} · {asset.width}x{asset.height}
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="empty-list">
                <p>Henüz dosya yok.</p>
                <p>Dosya seç ya da alana bırak.</p>
              </div>
            )}
          </div>
        </aside>

        <section className="preview-panel">
          <div className="preview-head">
            <div>
              <p className="panel-label">Seçili önizleme</p>
              <h2>{selectedAsset ? selectedAsset.name : 'Bir dosya seç'}</h2>
              {selectedAsset ? (
                <p className="preview-meta">
                  {selectedAsset.width}x{selectedAsset.height} · {selectedAsset.frames} frame ·{' '}
                  {formatDuration(selectedAsset.duration)}
                </p>
              ) : (
                <p className="preview-meta">Sağ tarafta tek dosya büyür, solda liste kalır.</p>
              )}
            </div>

            <div className="player-controls">
              <button
                type="button"
                className="button button-primary"
                onClick={() => setPlaying((current) => !current)}
                disabled={!selectedAsset}
              >
                {playing ? 'Duraklat' : 'Oynat'}
              </button>
              <label className="speed">
                <span>Hız</span>
                <input
                  type="range"
                  min="0.25"
                  max="3"
                  step="0.25"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  disabled={!selectedAsset}
                />
                <strong>{speed.toFixed(2)}x</strong>
              </label>
            </div>
          </div>

          <div className="stage">
            {selectedAsset ? (
              <div className="player-wrap">
                <div className="player" ref={previewRef} />
                <div className="scrub">
                  <span>
                    Kare {Math.round(frame)} / {selectedAsset.frames}
                  </span>
                  <input
                    type="range"
                    min="0"
                    max={selectedAsset.frames}
                    step="1"
                    value={Math.min(frame, selectedAsset.frames)}
                    onChange={(event) => {
                      const nextFrame = Number(event.target.value)
                      setFrame(nextFrame)
                      setPlaying(false)
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="stage-empty">
                <p>Önizleme için bir Lottie seç.</p>
                <p>50 dosyayı tek seferde yükleyebilirsin.</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
