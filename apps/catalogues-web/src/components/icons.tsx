import { C } from './tokens';

type Paths = string | string[];

export const Icon = ({
  d,
  size = 16,
  color = 'currentColor',
  viewBox = '0 0 24 24',
  stroke = true,
  fill = false,
}: {
  d: Paths;
  size?: number;
  color?: string;
  viewBox?: string;
  stroke?: boolean;
  fill?: boolean;
}) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox={viewBox}
    fill={fill ? color : 'none'}
    stroke={stroke ? color : 'none'}
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {Array.isArray(d) ? d.map((p) => <path key={p} d={p} />) : <path d={d} />}
  </svg>
);

export const MailIcon = () => (
  <Icon d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" />
);
export const LockIcon = () => (
  <Icon
    d={[
      'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2z',
      'M7 11V7a5 5 0 0110 0v4',
    ]}
  />
);
export const UserIcon = () => (
  <Icon d={['M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2', 'M12 11a4 4 0 100-8 4 4 0 000 8z']} />
);
export const Eye = () => (
  <Icon
    d={[
      'M1 12s4-8 11-8 11 8 11 8',
      'M1 12s4 8 11 8 11-8 11-8',
      'M12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0',
    ]}
  />
);
export const EyeOff = () => (
  <Icon
    d={[
      'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94',
      'M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19',
      'M1 1l22 22',
    ]}
  />
);
export const StudioIcon = () => (
  <Icon d={['M12 20h9', 'M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z']} size={18} />
);
export const CatalogueIcon = () => <Icon d="M4 6h16M4 10h16M4 14h16M4 18h16" size={18} />;
export const AssetsIcon = () => (
  <Icon
    d={[
      'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
      'M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
    ]}
    size={18}
  />
);
export const PricingIcon = () => (
  <Icon
    d="M12 2a10 10 0 100 20A10 10 0 0012 2zm0 0v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
    size={18}
  />
);
export const GarmentIcon = ({ size = 24 }: { size?: number }) => (
  <Icon
    d="M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.34 2.23l.58 3.57a1 1 0 00.99.86H6v10a2 2 0 002 2h8a2 2 0 002-2V10h2.15a1 1 0 00.99-.86l.58-3.57a2 2 0 00-1.34-2.23z"
    size={size}
  />
);
export const CheckIcon = ({ color = C.pink, size = 16 }: { color?: string; size?: number }) => (
  <Icon d="M20 6L9 17l-5-5" size={size} color={color} />
);
export const XIcon = ({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) => (
  <Icon d="M18 6L6 18M6 6l12 12" size={size} color={color} />
);
export const DownloadIcon = ({ size = 24 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 15V3" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
  </svg>
);
export const DriveIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M8 3h8l6 10.5-4 7H6l-4-7L8 3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M8 3l8 14M16 3l-8 14M4 13.5h16" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
export const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m21 21-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </svg>
);
export const ChevronRight = () => <Icon d="M9 18l6-6-6-6" />;
export const ChevronDown = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const ArrowLeft = () => <Icon d="M19 12H5M12 19l-7-7 7-7" size={20} />;
export const SortIcon = () => <Icon d={['M3 6h18', 'M7 12h10', 'M11 18h4']} />;
export const FilterIcon = () => <Icon d={['M22 3H2l8 9.46V19l4 2v-8.54L22 3z']} />;
export const UploadIcon = ({ size = 16 }: { size?: number }) => (
  <Icon d={['M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12']} size={size} />
);
export const SparkleIcon = () => (
  <Icon d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" size={14} />
);
export const RegenerateIcon = ({ size = 14 }: { size?: number }) => (
  <Icon
    d={['M3 12a9 9 0 0115.3-6.4L21 8', 'M21 4v4h-4', 'M21 12a9 9 0 01-15.3 6.4L3 16', 'M3 20v-4h4']}
    size={size}
  />
);
export const FullscreenIcon = () => (
  <Icon
    d={[
      'M8 3H5a2 2 0 00-2 2v3',
      'M21 8V5a2 2 0 00-2-2h-3',
      'M3 16v3a2 2 0 002 2h3',
      'M16 21h3a2 2 0 002-2v-3',
    ]}
  />
);
export const DotsIcon = () => (
  <Icon
    d="M12 5a1 1 0 100-2 1 1 0 000 2zm0 7a1 1 0 100-2 1 1 0 000 2zm0 7a1 1 0 100-2 1 1 0 000 2z"
    fill
    stroke={false}
  />
);
export const PlusIcon = ({ size = 14 }: { size?: number }) => (
  <Icon d="M12 5v14M5 12h14" size={size} />
);
export const UserRoundIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="8" r="5" />
    <path d="M20 21a8 8 0 0 0-16 0" />
  </svg>
);
export const ShoppingBagIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 10a4 4 0 0 1-8 0" />
    <path d="M3.103 6.034h17.794" />
    <path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z" />
  </svg>
);
export const CalendarDaysIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 2v4" />
    <path d="M16 2v4" />
    <rect width={18} height={18} x={3} y={4} rx={2} />
    <path d="M3 10h18" />
    <path d="M8 14h.01" />
    <path d="M12 14h.01" />
    <path d="M16 14h.01" />
    <path d="M8 18h.01" />
    <path d="M12 18h.01" />
    <path d="M16 18h.01" />
  </svg>
);
export const SquareIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </svg>
);
export const CheckSquareIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
export const MinusSquareIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M8 12h8" />
  </svg>
);
export const ImagesIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
    <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
    <circle cx="13" cy="7" r="1" fill="currentColor" />
    <rect x="8" y="2" width="14" height="14" rx="2" />
  </svg>
);
export const ImageDownIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21" />
    <path d="m14 19 3 3v-5.5" />
    <path d="m17 22 3-3" />
    <circle cx="9" cy="9" r="2" />
  </svg>
);
export const MonitorIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </svg>
);
export const SmartphoneIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5" y="2" width="14" height="20" rx="2.5" />
    <path d="M12 18h.01" />
  </svg>
);
export const MonitorPlayIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z" />
    <path d="M12 17v4" />
    <path d="M8 21h8" />
    <rect x="2" y="3" width="20" height="14" rx="2" />
  </svg>
);
export const LightbulbIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </svg>
);
export const ImagePlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 5h6" />
    <path d="M19 2v6" />
    <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    <circle cx="9" cy="9" r="2" />
  </svg>
);
export const SparklesIcon = ({ size = 18 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#sparkles-grad)"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <defs>
      <linearGradient id="sparkles-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#F55C7A" />
        <stop offset="100%" stopColor="#F6B553" />
      </linearGradient>
    </defs>
    <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
    <path d="M20 2v4" />
    <path d="M22 4h-4" />
    <circle cx="4" cy="20" r="2" />
  </svg>
);
export const SettingsIcon = () => (
  <Icon
    d={[
      'M12 15a3 3 0 100-6 3 3 0 000 6z',
      'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
    ]}
    size={18}
  />
);
export const LogOutIcon = () => (
  <Icon d={['M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4', 'M16 17l5-5-5-5', 'M21 12H9']} />
);
export const GiftIcon = () => (
  <Icon
    d={[
      'M20 12v10H4V12',
      'M22 7H2v5h20V7z',
      'M12 22V7',
      'M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z',
      'M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z',
    ]}
  />
);
export const MoonIcon = () => <Icon d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />;
export const SunIcon = () => (
  <Icon
    d={[
      'M12 1v2',
      'M12 21v2',
      'M4.22 4.22l1.42 1.42',
      'M18.36 18.36l1.42 1.42',
      'M1 12h2',
      'M21 12h2',
      'M4.22 19.78l1.42-1.42',
      'M18.36 5.64l1.42-1.42',
      'M12 17a5 5 0 100-10 5 5 0 000 10z',
    ]}
  />
);
export const TrashIcon = () => (
  <Icon
    d={[
      'M3 6h18',
      'M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
      'M10 11v6M14 11v6',
      'M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2',
    ]}
    size={14}
  />
);
export const SpinnerIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="av-spin"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);
export const GridIcon = () => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </svg>
);
export const FlagIN = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="12" height="3" fill="#FF9933" rx="0.5" />
    <rect x="2" y="6" width="12" height="3" fill="#FFFFFF" rx="0.5" />
    <rect x="2" y="9" width="12" height="3" fill="#138808" rx="0.5" />
    <circle cx="8" cy="7.5" r="1.2" stroke="#000080" strokeWidth="0.5" fill="none" />
  </svg>
);
export const FlagUS = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="12" height="1.25" fill="#B22234" rx="0.25" />
    <rect x="2" y="4.25" width="12" height="1.25" fill="#FFFFFF" rx="0.25" />
    <rect x="2" y="5.5" width="12" height="1.25" fill="#B22234" rx="0.25" />
    <rect x="2" y="6.75" width="12" height="1.25" fill="#FFFFFF" rx="0.25" />
    <rect x="2" y="8" width="12" height="1.25" fill="#B22234" rx="0.25" />
    <rect x="2" y="9.25" width="12" height="1.25" fill="#FFFFFF" rx="0.25" />
    <rect x="2" y="10.5" width="12" height="1.25" fill="#B22234" rx="0.25" />
    <rect x="2" y="3" width="5" height="5" fill="#3C3B6E" rx="0.5" />
    <circle cx="4" cy="4" r="0.4" fill="white" />
    <circle cx="5.5" cy="4" r="0.4" fill="white" />
    <circle cx="4" cy="5.5" r="0.4" fill="white" />
    <circle cx="5.5" cy="5.5" r="0.4" fill="white" />
    <circle cx="4.75" cy="4.75" r="0.4" fill="white" />
  </svg>
);
export const FlagGB = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="12" height="12" fill="#012169" rx="1" />
    <path d="M2 2h12v12H2z" fill="none" />
    <path
      d="M2 2l5 5V2H6l-4 4zM14 2l-5 5h1l4-4V2zM2 14l5-5H6l-4 4v1zM14 14l-5-5h-1l4 4v1z"
      fill="white"
    />
    <path d="M8 3h1v4h4v1H9v4H8V8H3v-.5l4.5-4.5H8z" fill="white" />
    <path d="M8 3v4h4v1H9v4H8V8H3v-.5l4.5-4.5H8z" fill="#C8102E" opacity="0.7" />
  </svg>
);
export const CameraIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);

export const InfoIcon = ({
  size = 16,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) => (
  <svg
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const FlagAE = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="3" height="10" fill="#FF0000" rx="0.5" />
    <rect x="5" y="3" width="9" height="3.33" fill="#00732F" rx="0.5" />
    <rect x="5" y="6.33" width="9" height="3.33" fill="#FFFFFF" rx="0.5" />
    <rect x="5" y="9.66" width="9" height="3.33" fill="#000000" rx="0.5" />
  </svg>
);
