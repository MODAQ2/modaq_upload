import Modal from "../common/Modal.tsx";
import { useAppStore } from "../../stores/appStore.ts";

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const version = useAppStore((s) => s.version);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="About"
      footer={
        <button
          onClick={onClose}
          className="px-4 py-2 bg-nlr-gray text-white rounded hover:opacity-90 text-sm"
        >
          Close
        </button>
      }
    >
      <div className="p-3 bg-gray-50 rounded">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-500">Version</span>
          <span className="font-mono text-sm font-semibold">
            {version?.version ?? "loading..."}
          </span>
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="text-sm text-gray-500">Commit</span>
          <span className="font-mono text-sm text-gray-600">
            {version?.commit ? version.commit.slice(0, 7) : "-"}
          </span>
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="text-sm text-gray-500">Branch</span>
          <span className="font-mono text-sm text-gray-600">
            {version?.branch ?? "-"}
          </span>
        </div>
      </div>
    </Modal>
  );
}
