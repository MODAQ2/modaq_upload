/**
 * Confirmation step for the delete workflow (Step 3).
 *
 * Requires the user to type "DELETE" and check a confirmation checkbox
 * before enabling the delete button. Emphasizes that S3 data is untouched.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

import { formatBytes } from "../../utils/format/bytes.ts";
import AlertBanner from "../common/AlertBanner.tsx";

interface DeleteConfirmationProps {
  totalFiles: number;
  totalSize: number;
  onConfirm: () => void;
  onBack: () => void;
}

export default function DeleteConfirmation({
  totalFiles,
  totalSize,
  onConfirm,
  onBack,
}: DeleteConfirmationProps) {
  const [typedText, setTypedText] = useState("");
  const [checked, setChecked] = useState(false);

  const isConfirmed = typedText === "CLEAR" && checked;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* Warning banner */}
      <AlertBanner
        type="error"
        title="This action is irreversible"
        message={
          <>
            You are about to permanently remove{" "}
            <strong>{totalFiles} local file{totalFiles !== 1 ? "s" : ""}</strong>{" "}
            ({formatBytes(totalSize)}) from this hard drive.
          </>
        }
      />

      {/* Cloud reassurance */}
      <AlertBanner
        type="shield"
        title="Cloud storage will NOT be affected"
        message={
          <>
            Only local copies are removed. Your files in{" "}
            <Link to="/files" className="underline hover:no-underline font-medium" title="Browse uploaded files in cloud storage">
              cloud storage
            </Link>
            {" "}remain safe and unchanged. Each file is verified against the cloud upload before removal.
          </>
        }
      />

      {/* Type-to-confirm */}
      <div>
        <label
          htmlFor="delete-confirm-input"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Type <strong className="text-red-600">CLEAR</strong> to confirm
        </label>
        <input
          id="delete-confirm-input"
          type="text"
          value={typedText}
          onChange={(e) => setTypedText(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
          placeholder="Type CLEAR here"
          autoComplete="off"
        />
      </div>

      {/* Checkbox */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
        />
        <span className="text-sm text-gray-700">
          I understand that cleared files cannot be recovered from this drive
          and that the cloud uploads have been verified.
        </span>
      </label>

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!isConfirmed}
          className={`px-4 py-2 text-sm font-medium text-white rounded-md ${
            isConfirmed
              ? "bg-red-600 hover:bg-red-700"
              : "bg-gray-300 cursor-not-allowed"
          }`}
        >
          Clear {totalFiles} File{totalFiles !== 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}
