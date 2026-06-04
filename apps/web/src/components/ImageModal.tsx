import { useEffect, useRef } from "react";

interface ImageModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

export default function ImageModal({ src, alt, onClose }: ImageModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the close button when the modal opens
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="image-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <button ref={closeButtonRef} className="image-modal-close" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close">
        &times;
      </button>
      <img
        src={src}
        alt={alt}
        className="image-modal-img"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
