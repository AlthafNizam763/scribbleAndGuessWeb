'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useGame } from '@/web/GameProvider';
import type { ChatMessageDto } from '@/web/types';

/**
 * Chat, which is also the guess channel.
 *
 * There is one input, and the server decides what a line means: during a turn
 * a guesser's message is scored as a guess, and a correct one never reaches
 * anybody as text — it comes back as an announcement carrying only the name.
 * That is why nothing here inspects the message before sending it. Deciding
 * locally whether something "is a guess" would leak the answer to any player
 * who read the network tab.
 */

const CLASS_FOR: Partial<Record<ChatMessageDto['type'], string>> = {
  system: 'chat__line--system',
  playerJoined: 'chat__line--system',
  playerLeft: 'chat__line--system',
  hint: 'chat__line--system',
  correctGuess: 'chat__line--correct',
  closeGuess: 'chat__line--close',
};

export function ChatPanel({ disabled = false }: { disabled?: boolean }) {
  const { chat, sendChat } = useGame();
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);

  // Follows the newest line. Without this the panel silently stops updating
  // for anyone who has not scrolled, which reads as chat being broken.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    await sendChat(value);
  }

  return (
    <div className="card chat">
      <h2>Chat</h2>

      <div className="chat__log" ref={logRef}>
        {chat.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Guesses and messages appear here.
          </p>
        ) : (
          chat.map((message) => (
            <div key={message.id} className={`chat__line ${CLASS_FOR[message.type] ?? ''}`}>
              {message.type === 'chat' || message.type === 'guess' ? (
                <>
                  <strong>{message.senderName}: </strong>
                  {message.text}
                </>
              ) : (
                message.text
              )}
            </div>
          ))
        )}
      </div>

      <form className="chat__form" onSubmit={submit}>
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={disabled ? 'You are drawing' : 'Type your guess…'}
          maxLength={120}
          disabled={disabled}
          aria-label="Message"
        />
        <button type="submit" disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
