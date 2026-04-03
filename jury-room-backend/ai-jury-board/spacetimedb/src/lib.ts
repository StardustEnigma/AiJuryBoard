export type MessageRecord = {
    sender: string;
    content: string;
    timestamp: number;
};

export type RoomStateRecord = {
    status: 'IDLE' | 'DEBATING' | 'ANALYZING';
    currentTurn: string;
};

type MessageDb = {
    insert: (row: MessageRecord) => void;
};

type JuryDbContext = {
    db: {
        message: MessageDb;
    };
};

export function postArgument(ctx: JuryDbContext, sender: string, content: string): void {
    const timestamp = Date.now();
    ctx.db.message.insert({ sender, content, timestamp });

    if (sender === 'Prosecutor') {
        // Turn-switch logic can be added when the room state table is wired in.
    }
}