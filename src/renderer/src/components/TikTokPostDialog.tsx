import { useEffect, useRef, useState } from 'react';
import type { TikTokCreatorInfo, TikTokPostOptions } from '../../../shared/operations';

const LEVEL_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me'
};
const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

/**
 * TikTok posting screen, following TikTok's Content Sharing Guidelines: shows the creator, a preview,
 * an editable caption, privacy chosen from TikTok's list with no default, interaction settings that respect
 * the creator's TikTok settings (off by default), commercial content disclosure, and the required consent text.
 */
export function TikTokPostDialog(props: {
  productionId: number;
  videoUrl: string | null;
  durationSec: number | null;
  caption: string;
  onPost: (o: TikTokPostOptions) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caption, setCaption] = useState(props.caption);
  const [privacy, setPrivacy] = useState('');
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    window.api.tiktokCreatorInfo(props.productionId).then(setInfo, (e) => setLoadError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)));
  }, [props.productionId]);

  useEffect(() => {
    if (brandContent && privacy === 'SELF_ONLY') setPrivacy('');
  }, [brandContent, privacy]);

  const tooLong = !!info && info.maxVideoPostDurationSec > 0 && (props.durationSec ?? 0) > info.maxVideoPostDurationSec;
  const commercialIncomplete = commercial && !brandOrganic && !brandContent;
  const canPost = !!info && !posting && privacy !== '' && !tooLong && !commercialIncomplete && caption.length <= 2200;
  const label = brandContent ? 'Paid partnership' : brandOrganic ? 'Promotional content' : null;

  const post = async () => {
    if (!canPost) return;
    setPosting(true);
    try {
      await props.onPost({ privacyLevel: privacy, caption, allowComment, allowDuet, allowStitch, brandOrganic: commercial && brandOrganic, brandContent: commercial && brandContent });
    } finally {
      setPosting(false);
    }
  };

  return (
    <dialog ref={ref} className="tt-dialog" aria-labelledby="tt-title" onClose={props.onClose} onCancel={(e) => posting && e.preventDefault()}>
      <h3 id="tt-title">Post to TikTok</h3>
      {loadError && <p className="field-error small" role="alert">Couldn't load your TikTok account: {loadError}</p>}
      {!info && !loadError && <p className="small" role="status"><span className="spinner" aria-hidden="true" /> Loading your TikTok account…</p>}
      {info && (
        <div className="tt-body">
          <div className="tt-preview">
            {props.videoUrl ? <video src={props.videoUrl} controls preload="metadata" aria-label="Video preview" /> : <p className="muted small">No preview available.</p>}
          </div>
          <div className="tt-form">
            <div className="tt-creator">
              {info.avatarUrl ? <img src={info.avatarUrl} alt="" className="tt-avatar" /> : <span className="tt-avatar tt-avatar-empty" aria-hidden="true" />}
              <div>
                <strong>{info.nickname || info.username}</strong>
                {info.username && <div className="muted small">@{info.username}</div>}
              </div>
            </div>
            {tooLong && <p className="field-error small" role="alert">This video is {Math.round(props.durationSec ?? 0)} s; this account can post videos up to {info.maxVideoPostDurationSec} s.</p>}

            <label className="tt-field">
              <span>Caption</span>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={4} maxLength={2200} />
              <span className="muted small">{caption.length}/2200 · labelled as AI-generated content</span>
            </label>

            <label className="tt-field">
              <span>Who can view this video</span>
              <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} required aria-required="true">
                <option value="" disabled>Select who can view</option>
                {info.privacyLevelOptions.map((l) => (
                  <option key={l} value={l} disabled={brandContent && l === 'SELF_ONLY'} title={brandContent && l === 'SELF_ONLY' ? 'Branded content visibility cannot be set to private.' : undefined}>
                    {LEVEL_LABEL[l] ?? l}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="tt-field">
              <legend>Allow users to</legend>
              <label className={info.commentDisabled ? 'tt-off' : ''}>
                <input type="checkbox" checked={allowComment && !info.commentDisabled} disabled={info.commentDisabled} onChange={(e) => setAllowComment(e.target.checked)} /> Comment
              </label>
              <label className={info.duetDisabled ? 'tt-off' : ''}>
                <input type="checkbox" checked={allowDuet && !info.duetDisabled} disabled={info.duetDisabled} onChange={(e) => setAllowDuet(e.target.checked)} /> Duet
              </label>
              <label className={info.stitchDisabled ? 'tt-off' : ''}>
                <input type="checkbox" checked={allowStitch && !info.stitchDisabled} disabled={info.stitchDisabled} onChange={(e) => setAllowStitch(e.target.checked)} /> Stitch
              </label>
              {(info.commentDisabled || info.duetDisabled || info.stitchDisabled) && <span className="muted small">Greyed-out options are turned off in your TikTok settings.</span>}
            </fieldset>

            <fieldset className="tt-field">
              <legend>
                <label>
                  <input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} /> Disclose commercial content
                </label>
              </legend>
              <span className="muted small">Turn on if this video promotes yourself, a third party, or both.</span>
              {commercial && (
                <>
                  <label>
                    <input type="checkbox" checked={brandOrganic} onChange={(e) => setBrandOrganic(e.target.checked)} /> Your brand <span className="muted small">(promoting yourself or your own business)</span>
                  </label>
                  <label>
                    <input type="checkbox" checked={brandContent} onChange={(e) => setBrandContent(e.target.checked)} /> Branded content <span className="muted small">(promoting another brand or third party)</span>
                  </label>
                  {commercialIncomplete && <span className="field-error small">Choose at least one option to continue.</span>}
                  {label && <span className="small">Your video will be labelled "{label}".</span>}
                </>
              )}
            </fieldset>

            <p className="small">
              By posting, you agree to TikTok's{' '}
              {commercial && brandContent && (
                <>
                  <a href={BRANDED_URL} target="_blank" rel="noreferrer">Branded Content Policy</a> and{' '}
                </>
              )}
              <a href={MUSIC_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
            </p>
            {posting && <p className="small" role="status"><span className="spinner" aria-hidden="true" /> Uploading… After posting, it can take a few minutes for the video to process and appear on your profile.</p>}
          </div>
        </div>
      )}
      <div className="prod-actions">
        <button className="primary" disabled={!canPost} onClick={() => void post()}>{posting ? 'Posting…' : 'Post'}</button>
        <button className="secondary" disabled={posting} onClick={() => ref.current?.close()}>Cancel</button>
      </div>
    </dialog>
  );
}
