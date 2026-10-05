import { motion } from 'motion/react'
import { ArrowDownToLine, Cpu, HardDrive, WifiOff } from 'lucide-react'
import { api } from '../api'
import { Backdrop } from '../components/Backdrop'
import type { Intake } from '../components/FileIntake'
import { GooglePayGuide } from '../components/GooglePayGuide'
import { ImportActivity } from '../components/ImportActivity'
import { PlutusLogo } from '../components/brand/PlutusLogo'
import { Header } from '../components/Header'
import { SourceTiles } from '../components/SourceTiles'
import { Vault } from '../components/Vault'
import { aiPanel } from '../lib/aiPanel'
import type { LedgerData } from '../lib/ledger'
import { SOURCES } from '../lib/sources'
import { useStorage } from '../lib/storage'
import type { Activity } from '../lib/useImportActivity'

const ease = [0.16, 1, 0.3, 1] as const

interface Props {
  data: LedgerData
  refresh: () => void
  intake: Intake
  activity: Activity
}

export function Welcome({ data, refresh, intake, activity }: Props) {
  const { uploads, cards } = data
  const browse = intake.browse
  const storage = useStorage()

  const deleteUpload = async (id: string) => {
    await api.deleteUpload(id).catch(() => intake.notify("Couldn't delete that file"))
    refresh()
  }

  const hasVault = uploads.length > 0

  return (
    <div className="relative min-h-dvh pb-28">
      <Backdrop />
      <Header activity={activity} actions={<ImportActivity activity={activity} pending={intake.pending} />} />

      <main className="mx-auto max-w-6xl px-6">
        <section className="mx-auto max-w-3xl pt-12 text-center sm:pt-16">
          <motion.div
            initial={{ opacity: 0, scale: 0.8, rotate: -8 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 180, damping: 14 }}
            className="mb-6 flex justify-center"
          >
            <PlutusLogo className="size-24 drop-shadow-[0_10px_40px_rgb(247_179_45/0.35)] sm:size-28" animated title="Plutus" />
          </motion.div>
          <motion.span
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease }}
            className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-zinc-400"
          >
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Private expense tracking for cards and UPI
          </motion.span>
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.06, ease }}
            className="mt-6 font-display text-[40px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[56px]"
          >
            {hasVault ? (
              'Add more to your vault.'
            ) : (
              <>
                See where every <span className="text-gradient">rupee</span> goes.
              </>
            )}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.12, ease }}
            className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-pretty text-zinc-400"
          >
            {hasVault
              ? 'Each new statement fills in more of the picture. Re-adding a file is harmless: duplicates are caught automatically.'
              : 'Start with your card statements, UPI history and payment screenshots. Everything is read right here on this Mac, by local parsers and an on-device model. Nothing is sent anywhere.'}
          </motion.p>
        </section>

        <section className="mt-14">
          <SourceTiles onPick={browse} />

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.55, duration: 0.6 }}
            className="mt-3 flex flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-white/[0.1] bg-white/[0.012] px-6 py-9 text-center sm:flex-row sm:text-left"
          >
            <motion.span
              animate={{ y: [0, -4, 0] }}
              transition={{ repeat: Infinity, duration: 3.2, ease: 'easeInOut' }}
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white/[0.05] text-zinc-300 ring-1 ring-white/10"
            >
              <ArrowDownToLine className="size-5" />
            </motion.span>
            <div>
              <p className="text-zinc-200">Or drop a mix of files anywhere on this page</p>
              <p className="mt-0.5 text-sm text-zinc-500">
                We work out which is which ·{' '}
                <button type="button" onClick={() => browse()} className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
                  browse your Mac
                </button>
              </p>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.62, duration: 0.6 }} className="mt-3">
            <GooglePayGuide onZip={() => browse(SOURCES.find((s) => s.kind === 'upi_statement'))} onFolder={intake.browseFolder} />
          </motion.div>

          <motion.ul
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.6 }}
            className="mt-8 grid gap-4 text-sm sm:grid-cols-3"
          >
            {[
              { icon: HardDrive, title: 'Stays on this Mac', text: `Files are kept in ${storage?.display ?? "Plutus's data folder"}, with everything else it learns about you.` },
              {
                icon: Cpu,
                title: 'Optional local AI',
                text: (
                  <>
                    New payees sorted on this Mac by a model that suits it. Without it, you sort them once.{' '}
                    <button type="button" onClick={aiPanel.open} className="text-zinc-300 underline decoration-white/30 underline-offset-4 hover:decoration-white">
                      Check this Mac
                    </button>
                  </>
                ),
              },
              { icon: WifiOff, title: 'Works offline', text: 'No accounts, no cloud, no analytics. Try it with Wi-Fi off.' },
            ].map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" strokeWidth={1.8} />
                <div>
                  <p className="text-zinc-300">{title}</p>
                  <p className="text-zinc-500">{text}</p>
                </div>
              </li>
            ))}
          </motion.ul>
        </section>

        <Vault uploads={uploads} cards={cards} onDelete={deleteUpload} />
      </main>
    </div>
  )
}
