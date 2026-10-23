import { type SVGProps, useId } from "react";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const CursorIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 466.73 532.09" fill="currentColor">
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const McpIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 180 180" fill="none">
    <path
      d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
    />
    <path
      d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
    />
    <path
      d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
    />
  </svg>
);

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const OpenAI: Icon = (props) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 260" fill="currentColor">
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
);

export const ClaudeAI: Icon = (props) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 257">
    <path
      fill="#D97757"
      d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
    />
  </svg>
);

export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

export const ACPRegistryIcon = McpIcon;
export const GithubCopilotIcon = GitHubIcon;
export const PiAgentIcon = OpenAI;

const ANTIGRAVITY_ICON_DATA_URL =
  "data:image/png;base64,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";

export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" />
  </svg>
);

export const IntelliJIdeaIcon: Icon = (props) => {
  const id = useId();
  const gradientAId = `${id}-idea-a`;
  const gradientBId = `${id}-idea-b`;
  const gradientCId = `${id}-idea-c`;
  const gradientDId = `${id}-idea-d`;

  return (
    <svg {...props} viewBox="0 0 70 70" fill="none">
      <defs>
        <linearGradient
          id={gradientAId}
          x1="0.7898"
          y1="40.0893"
          x2="33.3172"
          y2="40.0893"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.2581" stopColor="#F97A12" />
          <stop offset="0.4591" stopColor="#B07B58" />
          <stop offset="0.7241" stopColor="#577BAE" />
          <stop offset="0.9105" stopColor="#1E7CE5" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientBId}
          x1="25.7674"
          y1="24.88"
          x2="79.424"
          y2="54.57"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F97A12" />
          <stop offset="0.07179946" stopColor="#CB7A3E" />
          <stop offset="0.1541" stopColor="#9E7B6A" />
          <stop offset="0.242" stopColor="#757B91" />
          <stop offset="0.3344" stopColor="#537BB1" />
          <stop offset="0.4324" stopColor="#387CCC" />
          <stop offset="0.5381" stopColor="#237CE0" />
          <stop offset="0.6552" stopColor="#147CEF" />
          <stop offset="0.7925" stopColor="#0B7CF7" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientCId}
          x1="63.2277"
          y1="42.9153"
          x2="48.2903"
          y2="-1.7191"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FE315D" />
          <stop offset="0.07840246" stopColor="#CB417E" />
          <stop offset="0.1601" stopColor="#9E4E9B" />
          <stop offset="0.2474" stopColor="#755BB4" />
          <stop offset="0.3392" stopColor="#5365CA" />
          <stop offset="0.4365" stopColor="#386DDB" />
          <stop offset="0.5414" stopColor="#2374E9" />
          <stop offset="0.6576" stopColor="#1478F3" />
          <stop offset="0.794" stopColor="#0B7BF8" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientDId}
          x1="10.7204"
          y1="16.473"
          x2="55.5237"
          y2="90.58"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#FE315D" />
          <stop offset="0.04" stopColor="#F63462" />
          <stop offset="0.1041" stopColor="#DF3A71" />
          <stop offset="0.1842" stopColor="#C24383" />
          <stop offset="0.2771" stopColor="#AD4B93" />
          <stop offset="0.3853" stopColor="#A0519B" />
          <stop offset="0.5412" stopColor="#9B539E" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
      </defs>
      <path
        d="M15.8711 54.3321L0.789795 42.8324L8.00135 29.4399L21.4851 34.7654L15.8711 54.3321Z"
        fill={`url(#${gradientAId})`}
      />
      <path
        d="M69.1478 10.6058L68.3958 47.269L43.4182 69.1593L22.5117 60.9097L25.7423 49.6927L40.3511 34.0617L25.8336 21.6034L28.973 8.88086H54.0303L69.1478 10.6058Z"
        fill={`url(#${gradientBId})`}
      />
      <path
        d="M69.1479 10.6058L42.2908 21.1491L38.8992 8.88086H54.0304L69.1479 10.6058Z"
        fill={`url(#${gradientCId})`}
      />
      <path
        d="M33.5498 0.789795L0.789795 42.8324L15.8129 54.3787L21.1239 69.1513L46.1095 69.1513L69.1478 10.6058L33.5498 0.789795Z"
        fill={`url(#${gradientDId})`}
      />
      <path d="M13.7461 13.5034H56.2461V56.0034H13.7461V13.5034Z" fill="black" />
      <path
        d="M20.9124 48.0348V44.6516H32.4124V48.0348H20.9124ZM25.5098 19.4517V36.5018H22.2207V19.4517H25.5098ZM30.0624 36.5597C29.1937 36.5597 28.4388 36.4049 27.7978 36.0955C27.1569 35.786 26.6221 35.3376 26.1934 34.7501L28.5704 32.8507C28.841 33.2051 29.1277 33.4725 29.4306 33.6527C29.7394 33.8329 30.0997 33.923 30.5115 33.923C31.0551 33.923 31.4867 33.7562 31.8062 33.4227C32.1314 33.0834 32.294 32.5802 32.294 31.9132V19.4517H35.5734V32.0485C35.5734 32.9478 35.3802 33.7323 34.9938 34.4018C34.6131 35.0713 34.0666 35.5928 33.3543 35.9666C32.6421 36.3404 31.8781 36.5414 31.0629 36.5694L30.0624 36.5597Z"
        fill="white"
      />
      <path
        d="M43.1624 48.0348C42.5389 48.0348 41.9501 47.9331 41.3958 47.7296C40.8472 47.5202 40.3646 47.2204 39.948 46.8301C39.5371 46.4339 39.2133 45.9561 38.9766 45.3966L41.4987 43.9312C41.6789 44.2624 41.8918 44.5429 42.1376 44.7722C42.3892 45.0014 42.6697 45.1758 42.979 45.295C43.2941 45.4142 43.6322 45.4738 43.993 45.4738C44.4145 45.4738 44.7739 45.4112 45.0718 45.2863C45.3697 45.1552 45.5989 44.9815 45.7595 44.7654C45.9201 44.5436 46.0004 44.2958 46.0004 44.0215C46.0004 43.7218 45.9171 43.4651 45.7504 43.2516C45.5898 43.0381 45.3545 42.8549 45.0441 42.7019C44.7337 42.5434 44.3588 42.3949 43.9195 42.2561L42.9124 41.9487C41.9003 41.6347 41.1137 41.1952 40.5527 40.6304C39.9917 40.0601 39.7112 39.314 39.7112 38.3921C39.7112 37.6155 39.8963 36.9368 40.2664 36.356C40.6424 35.7752 41.1568 35.3216 41.8097 34.9952C42.4625 34.6638 43.2072 34.4981 44.0438 34.4981C44.8696 34.4981 45.6071 34.6638 46.2568 34.9952C46.9064 35.3216 47.4148 35.7724 47.782 36.3473C48.1492 36.9225 48.3389 37.5898 48.3517 38.3497L45.7377 39.7651C45.6543 39.397 45.5062 39.0818 45.2933 38.8197C45.0868 38.5577 44.8341 38.3556 44.5357 38.2134C44.2448 38.0709 43.9198 37.9996 43.5605 37.9996C43.2053 37.9996 42.8957 38.0581 42.6319 38.1751C42.3748 38.2918 42.1748 38.4559 42.0319 38.6671C41.8889 38.8724 41.8174 39.1126 41.8174 39.387C41.8174 39.662 41.8912 39.9023 42.0384 40.1073C42.1914 40.3126 42.4136 40.4918 42.7051 40.645C43.0028 40.798 43.366 40.9412 43.7945 41.0749L44.7962 41.3915C45.4736 41.5971 46.0838 41.8562 46.6266 42.1689C47.169 42.4766 47.5988 42.8751 47.9165 43.3645C48.2342 43.8491 48.3931 44.4673 48.3931 45.219C48.3931 45.9956 48.1939 46.6852 47.7958 47.2874C47.4036 47.8896 46.8592 48.3634 46.1624 48.7084C45.4713 49.0531 44.6711 49.2257 43.7618 49.2257L43.1624 48.0348Z"
        fill="white"
      />
    </svg>
  );
};

// TODO: Replace with official Kiro brand SVG once it is provided. For now this
// is a simple stylized "K" glyph that mirrors the visual weight of sibling
// editor icons (Cursor, Zed) in OpenInPicker.
export const KiroIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M6 3v18M6 12l8-9M6 12l8 9"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const OpenCodeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#opencode__clip0_1311_94969)">
      <path d="M24 32H8V16H24V32Z" fill="#BCBBBB" />
      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#211E1E" />
    </g>
    <defs>
      <clipPath id="opencode__clip0_1311_94969">
        <rect width="32" height="40" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

/** Neutral Pi monogram. */
export const PiIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M6 10h20M12 10v13M22 10v11q0 3 4 2"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Neutral monogram for Muse Code; F5 does not ship Meta's brand mark. */
export const MuseIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="26" height="26" rx="7" stroke="currentColor" strokeWidth="2.5" />
    <path
      d="M9.5 22V10.5L16 18L22.5 10.5V22"
      stroke="currentColor"
      strokeWidth="2.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const GrokIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 7L25 25M25 7L7 25" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <path
      d="M20.5 4.5H27.5V11.5"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
