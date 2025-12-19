import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from "@prisma/client";

import dotenv from "dotenv";
dotenv.config();

const prismaclient = new PrismaClient();
const server = createServer(); // node server

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://snapchat-vert.vercel.app"
    ],
    credentials: true,
  }
});

const onlineusers = {};

/* ===============================
   🔹 Utility Functions
================================ */

function isSameDay(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function handlesnap(senderid, receiverid) {
  const friendships = await prismaclient.friends.findMany({
    where: {
      OR: [
        { userId: senderid, friendId: receiverid },
        { userId: receiverid, friendId: senderid }
      ]
    }
  });

  if (friendships.length === 0) return;

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  for (const f of friendships) {
    const last = f.lastsnapat ? new Date(f.lastsnapat) : null;

    if (last && isSameDay(last, now)) {
      await prismaclient.friends.update({
        where: { id: f.id },
        data: { lastsnapat: now }
      });
    } else if (last && isSameDay(last, yesterday)) {
      await prismaclient.friends.update({
        where: { id: f.id },
        data: {
          streaks: { increment: 1 },
          lastsnapat: now
        }
      });
    } else {
      await prismaclient.friends.update({
        where: { id: f.id },
        data: {
          streaks: 1,
          lastsnapat: now
        }
      });
    }
  }
}

/* ===============================
   🔹 Socket Connection
================================ */

io.on("connection", (socket) => {
  console.log(`user connected ${socket.id}`);

  /* ===============================
     🔸 user_connected
  ================================ */
  socket.on("user_connected", ({ userId }) => {
    onlineusers[userId] = socket.id;
    console.log('registered users:', userId, socket.id);
  });

  /* ===============================
     🔸 disconnect
  ================================ */
  socket.on("disconnect", () => {
    for (const uid in onlineusers) {
      if (onlineusers[uid] === socket.id) {
        delete onlineusers[uid];
        console.log(`user disconnectd ${socket.id}`);
        break;
      }
    }
  });

  /* ===============================
     🔸 join_room
  ================================ */
  socket.on("join_room", ({ userId, friendid }) => {
    const roomid = [userId, friendid].sort().join("_");
    socket.join(roomid);
    console.log(`${userId} joined ${roomid}`);
  });

  /* ===============================
     🔸 send_msg
  ================================ */
  socket.on("send_msg", async ({ roomid, msg }) => {
    console.log("message:", msg);

    const resp = await prismaclient.messages.create({
      data: msg
    });

    io.to(roomid).emit("rec_msg", { resp });

    const receiver = await prismaclient.user.findUnique({
      where: { id: msg.receiverid },
      select: { clerkId: true },
    });

    if (!receiver) return;

    const friendSocketId = onlineusers[receiver.clerkId];
    console.log("📤 emitting friend_lastmsg to", friendSocketId);

    if (friendSocketId) {
      io.to(friendSocketId).emit("friend_lastmsg", { resp });
    }

    if (msg.type == "SNAP") {
      await handlesnap(msg.senderid, msg.receiverid);
    }
  });

  /* ===============================
     🔸 open_snap
  ================================ */
  socket.on("open_snap", async ({ mid, roomid }) => {
    if (!mid || !roomid) {
      console.log("❌ open_snap called without mid");
      return;
    }

    const resp = await prismaclient.messages.update({
      where: { id: mid },
      data: { isopened: true }
    });

    io.to(roomid).emit("rec_snap", { resp });

    if (!resp.expiresAt) return;

    const delay = resp.expiresAt.getTime() - Date.now();

    if (delay <= 0) {
      await prismaclient.messages.delete({ where: { id: mid } });
      io.to(roomid).emit("snap_deleted", { mid });
      return;
    }

    setTimeout(async () => {
      try {
        await prismaclient.messages.delete({ where: { id: mid } });
        io.to(roomid).emit("snap_deleted", { mid });
      } catch (err) {
        console.error("Snap delete failed:", err);
      }
    }, delay);
  });

  /* ===============================
     🔸 sent_notification
  ================================ */

  socket.on("sent_multi_notification",async ({ senderid, receiversid,type,message })=>{
     for (const receiverid of receiversid) {
      const roomid = [senderid, receiverid].sort().join("_");
      const resp=await prismaclient.notifications.create({
        data:{
          senderid,
          receiverid,
          type,
          message,
          roomid,
          isopened:false,
        }
      })
      const receiver = await prismaclient.user.findUnique({
        where: { id: receiverid },
        select: { clerkId: true },
      });

      if (!receiver) continue;

      const sender = await prismaclient.user.findUnique({
        where: { id: senderid },
        select: {
          id: true,
          clerkId: true,
          name: true,
          avatar: true,
        },
      });

      if (!sender) continue;

      const recsocketid = onlineusers[receiver.clerkId];

      if (recsocketid) {
        io.to(recsocketid).emit("new_notification", {
          resp: {
            ...resp,
            sender,
            isopened: resp.isopened ?? false,
          },
        });

        io.to(recsocketid).emit("rec_notification", {
          resp: {
            ...resp,
            sender,
          },
        });
      }
      
    }
  })
  //
  socket.on("sent_notification", async (msg) => {
    try {
      const resp = await prismaclient.notifications.create({
        data: {
          senderid: msg.senderid,
          receiverid: msg.receiverid,
          type: msg.type,
          message: msg.message ?? null,
          roomid: msg.roomid ?? null,
          messageid: msg.messageid ?? null,
          isopened: false,
        },
      });

      const receiver = await prismaclient.user.findUnique({
        where: { id: msg.receiverid },
        select: { clerkId: true },
      });

      if (!receiver) return;

      const sender = await prismaclient.user.findUnique({
        where: { id: msg.senderid },
        select: {
          id: true,
          clerkId: true,
          name: true,
          avatar: true,
        },
      });

      if (!sender) return;

      const recsocketid = onlineusers[receiver.clerkId];

      if (recsocketid) {
        io.to(recsocketid).emit("new_notification", {
          resp: {
            ...resp,
            sender,
            isopened: resp.isopened ?? false,
          },
        });

        io.to(recsocketid).emit("rec_notification", {
          resp: {
            ...resp,
            sender,
          },
        });
      }
    } catch (err) {
      console.error("❌ Notification handler failed:", err);
    }
  });

  /* ===============================
     🔸 sent_multi_snap
  ================================ */
  socket.on("sent_multi_snap", async ({ senderid, receiversid, mediaurl, type }) => {
    for (const receiverid of receiversid) {
      const roomid = [senderid, receiverid].sort().join("_");

      const resp = await prismaclient.messages.create({
        data: {
          senderid,
          receiverid,
          roomid,
          mediaurl,
          type,
          isopened: false,
          expiresAt: new Date(Date.now() + 10 * 1000),
        },
      });

      io.to(roomid).emit("rec_snap", { resp });

      const receiver = await prismaclient.user.findUnique({
        where: { id: receiverid },
        select: { clerkId: true },
      });

      const socketId = onlineusers[receiver?.clerkId];
      if (socketId) {
        io.to(socketId).emit("friend_lastmsg", { resp });
      }

      await handlesnap(senderid, receiverid);
    }
  });

});

/* ===============================
   🔹 Server Start
================================ */

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`🚀 Socket server running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  console.log("🔴 Shutting down...");
  await prismaclient.$disconnect();
  process.exit(0);
});
