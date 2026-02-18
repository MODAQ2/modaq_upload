import { useCallback, useState } from "react";

import { apiPost } from "../../api/client.ts";
import { LockIcon, SpinnerIcon, SuccessIcon, WarningIcon } from "../../utils/icons.tsx";
import Modal from "../common/Modal.tsx";

interface FixPermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  folderPath: string;
  onFixed: () => void;
}

export default function FixPermissionsModal({
  isOpen,
  onClose,
  folderPath,
  onFixed,
}: FixPermissionsModalProps) {
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!password.trim()) return;

      setIsLoading(true);
      setError(null);

      try {
        await apiPost("/api/delete/fix-permissions", {
          folder_path: folderPath,
          password,
        });
        setSuccess(true);
        setPassword("");
        onFixed();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to fix permissions";
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [password, folderPath, onFixed],
  );

  const handleClose = useCallback(() => {
    setPassword("");
    setError(null);
    setSuccess(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Fix Permissions"
      footer={
        !success ? (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="fix-permissions-form"
              disabled={isLoading || !password.trim()}
              className="px-4 py-2 text-sm font-medium rounded transition-colors bg-nlr-blue text-white hover:bg-nlr-blue-light disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isLoading && (
                <SpinnerIcon className="w-4 h-4 animate-spin" />
              )}
              Fix Permissions
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium rounded transition-colors bg-nlr-blue text-white hover:bg-nlr-blue-light"
          >
            Close
          </button>
        )
      }
    >
      {success ? (
        <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg border border-green-200">
          <SuccessIcon className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-800">
            Permissions fixed successfully. The scan results will be refreshed.
          </p>
        </div>
      ) : (
        <form id="fix-permissions-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
            <LockIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p>
                The files on this drive are owned by a different user. Your sudo
                password is needed to change ownership so files can be deleted.
              </p>
              <p className="mt-1 text-amber-700">
                Your password is sent directly to the system and is never stored
                or logged.
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="sudo-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Sudo Password
            </label>
            <input
              id="sudo-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-nlr-blue focus:border-transparent"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-200">
              <WarningIcon className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
