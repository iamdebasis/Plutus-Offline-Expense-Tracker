import { useSyncExternalStore } from 'react'
import { useFileIntake } from './components/FileIntake'
import { useLedger } from './lib/ledger'
import { useImportActivity } from './lib/useImportActivity'
import { CardGallery } from './pages/CardGallery'
import { Dashboard } from './pages/Dashboard'
import { Welcome } from './pages/Welcome'

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The welcome screen until there's something to show; the dashboard after that. #card-gallery shows
 *  every card design (follows the URL as it changes, not just on first load).
 *  Adding files and following their reading live here, above both pages, so a run that starts on the
 *  welcome screen carries on when the first file turns it into the dashboard. */
export function App() {
  const { data, error, refresh } = useLedger()
  const activity = useImportActivity(refresh)
  const intake = useFileIntake(activity, refresh)
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash)
  if (hash === '#card-gallery') return <CardGallery />
  if (error && !data) {
    return <p className="p-10 text-center text-sm text-zinc-400">Couldn't reach the local server ({error}). Is it running?</p>
  }
  if (!data) return null
  const empty = data.txns.length === 0 && data.payments.length === 0
  return (
    <>
      {empty ? (
        <Welcome data={data} refresh={refresh} intake={intake} activity={activity} />
      ) : (
        <Dashboard data={data} refresh={refresh} intake={intake} activity={activity} />
      )}
      {intake.element}
    </>
  )
}
