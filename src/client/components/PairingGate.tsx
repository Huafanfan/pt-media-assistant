import { KeyRound, ShieldCheck } from "lucide-react";
import { FormEvent } from "react";

export function PairingGate({
  code,
  onCodeChange,
  onSubmit,
  loading,
  error
}: {
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <main className="pairing-gate" aria-labelledby="pairing-title">
      <div className="pairing-mark" aria-hidden="true">
        <KeyRound size={25} strokeWidth={1.7} />
      </div>
      <p className="eyebrow">首次连接</p>
      <h2 id="pairing-title">输入配对码</h2>
      <p className="pairing-lede">输入片源服务终端显示的六位数字，让这台设备加入家庭网络。</p>

      <form className="pairing-form" onSubmit={onSubmit}>
        <label htmlFor="pairing-code">六位配对码</label>
        <input
          id="pairing-code"
          className="pairing-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
          autoFocus
          aria-describedby="pairing-help"
          aria-invalid={Boolean(error)}
        />
        <p id="pairing-help" className="field-help">
          配对码仅用于建立本地会话，不会离开当前网络。
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="primary-button pairing-submit" type="submit" disabled={loading || code.length !== 6}>
          {loading ? "正在连接…" : "配对设备"}
        </button>
      </form>

      <div className="pairing-security">
        <ShieldCheck size={18} strokeWidth={1.8} aria-hidden="true" />
        <span>本地连接受保护。配对成功后，搜索和下载操作仍需明确确认。</span>
      </div>
    </main>
  );
}
