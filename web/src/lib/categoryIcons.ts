import {
  ArrowLeftRight, Banknote, Car, CircleHelp, Clapperboard, GraduationCap, HeartPulse, House, Plane, Receipt, Repeat,
  Shield, ShoppingBag, ShoppingBasket, Sparkles, TrendingUp, UtensilsCrossed, Zap, type LucideIcon,
} from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  food: UtensilsCrossed,
  groceries: ShoppingBasket,
  transport: Car,
  shopping: ShoppingBag,
  bills: Zap,
  entertainment: Clapperboard,
  subscriptions: Repeat,
  health: HeartPulse,
  travel: Plane,
  home: House,
  education: GraduationCap,
  personal_care: Sparkles,
  insurance: Shield,
  fees: Receipt,
  cash: Banknote,
  investments: TrendingUp,
  transfers: ArrowLeftRight,
}

export const categoryIcon = (id: string): LucideIcon => ICONS[id.split('.')[0]] ?? CircleHelp
