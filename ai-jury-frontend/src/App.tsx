import { useMemo, useState } from 'react'
import { SpacetimeDBProvider, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from './module_bindings';

const SERVER_URL = 'http://localhost:3000';
const DATABASE_NAME = 'ai-jury-board';

function JurySessionList({ conn }: { conn: DbConnection }) {
  const [sessions, isLoading] = useTable(tables.jurySession);
  const [topic, setTopic] = useState('');

  const handleCreate = () => {
    if (!topic.trim()) return;
    conn.reducers.createSession({ topic, maxRounds: 6n });
    setTopic('');
  };

  const handleStart = (sessionId: bigint) => {
    conn.reducers.startDebate({ sessionId });
  };

  return (
    <div className="p-6 border rounded-lg bg-gray-50 shadow-sm mt-4">
      <h2 className="text-xl font-bold mb-4">Jury Sessions</h2>

      {isLoading && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          Syncing session subscription...
        </div>
      )}
      
      <div className="flex gap-2 mb-6">
        <input 
          className="border p-2 rounded flex-1" 
          placeholder="Enter a new topic for debate..."
          value={topic}
          onChange={e => setTopic(e.target.value)}
        />
        <button onClick={handleCreate} className="bg-blue-600 text-white px-4 py-2 rounded font-semibold hover:bg-blue-700">
          Create Session
        </button>
      </div>

      <div className="space-y-4">
        {sessions.length === 0 ? (
          <p className="text-gray-500">No sessions yet.</p>
        ) : (
          sessions.map(s => (
            <div key={s.id.toString()} className="bg-white p-4 border rounded shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg">{s.topic}</h3>
                  <div className="text-sm text-gray-500 mt-1">
                    Status: <span className="font-semibold uppercase text-indigo-600">{s.status}</span> | 
                    Turn: <span className="font-semibold">{s.currentTurn}</span> | 
                    Round: {s.roundNumber.toString()} / {s.maxRounds.toString()}
                  </div>
                </div>
                {s.status === 'idle' && (
                  <button 
                    onClick={() => handleStart(s.id)}
                    className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                  >
                    Start Debate
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function JuryRoom() {
  const connectionState = useSpacetimeDB();
  const conn = connectionState.getConnection() as DbConnection | null;
  const identity = connectionState.identity?.toHexString();
  const connectionError = connectionState.connectionError?.message;

  return (
    <div className="max-w-4xl mx-auto p-8 font-sans">
      <h1 className="text-3xl font-black">AI Jury Room</h1>
      <p className="text-gray-600 mb-8 mt-2">Local Frontend Testing Harness</p>

      {connectionError && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Connection error: {connectionError}
        </div>
      )}

      {!connectionState.isActive || !conn ? (
        <div className="bg-blue-50 text-blue-800 p-4 rounded-lg">Connecting to SpacetimeDB...</div>
      ) : (
        <>
          <div className="bg-green-50 text-green-800 p-4 rounded-lg mb-6 flex justify-between items-center">
            <span>Connected to <b>{DATABASE_NAME}</b></span>
            <span className="font-mono text-sm bg-white px-2 py-1 rounded">{identity ? `${identity.substring(0, 8)}...` : 'anonymous'}</span>
          </div>

          <JurySessionList conn={conn} />
        </>
      )}
    </div>
  );
}

function App() {
  const connectionBuilder = useMemo(
    () => DbConnection.builder().withUri(SERVER_URL).withDatabaseName(DATABASE_NAME),
    []
  );

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <JuryRoom />
    </SpacetimeDBProvider>
  );
}

export default App
