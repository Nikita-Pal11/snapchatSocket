import {createServer} from 'http';
import {Server} from 'socket.io';
import { PrismaClient } from "@prisma/client";


const prismaclient = new PrismaClient();
const server=createServer();//node server
const io=new Server(server,{
    cors:{
        origin:process.env.NEXT_PUBLIC_URL,
    }
})
const onlineusers={};
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
    } 
    else if (last && isSameDay(last, yesterday)) {
      
      await prismaclient.friends.update({
        where: { id: f.id },
        data: {
          streaks: { increment: 1 },
          lastsnapat: now
        }
      });
    } 
    else {
      
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

io.on("connection",(socket)=>{
    console.log(`user connected ${socket.id}`);
    socket.on("user_connected",({userId})=>{
         onlineusers[userId]=socket.id;
         console.log('registered users:',userId,socket.id);
    });
    socket.on("disconnect",()=>{
        for(const uid in onlineusers){
            if(onlineusers[uid]===socket.id){
                delete onlineusers[uid];
                console.log(`user disconnectd ${socket.id}`);
                break;
            }
        }
    })

   socket.on("join_room",({userId,friendid})=>{
       const roomid=[userId,friendid].sort().join("_");
       socket.join(roomid);
       console.log(`${userId} joined ${roomid}`);
       
   })
   socket.on("send_msg",async ({roomid,msg})=>{
    console.log("message:", msg);
    const resp=await prismaclient.messages.create({
        data:msg
    })
    io.to(roomid).emit("rec_msg",{resp})
    
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
    if(msg.type=="SNAP"){
        await handlesnap(msg.senderid,msg.receiverid);
    }
   })
   socket.on("open_snap",async ({mid,roomid})=>{
     if (!mid || !roomid) {
    console.log("❌ open_snap called without mid");
    return;
  }
      const resp= await prismaclient.messages.update({
        where:{
            id:mid
        },
        data:{isopened:true}
       })
       console.log(resp);
      
       io.to(roomid).emit("rec_snap", { resp });
        if (!resp.expiresAt) return;

  const delay = resp.expiresAt.getTime() - Date.now();

  // If expiry time already passed → delete now
  if (delay <= 0) {
    await prismaclient.messages.delete({ where: { id: mid } });
    io.to(roomid).emit("snap_deleted", { mid });
    return;
  }

  // Schedule deletion
  setTimeout(async () => {
    try {
      await prismaclient.messages.delete({ where: { id: mid } });
      io.to(roomid).emit("snap_deleted", { mid });
    } catch (err) {
      console.error("Snap delete failed:", err);
    }
  }, delay);
       
   })
    socket.on("sent_notification",async (msg)=>{
       const resp =await prismaclient.notifications.create({
            data:msg
          })
           const receiver=await prismaclient.user.findUnique({
          where :{
            id:msg.receiverid
          }
        })
        if(!receiver)return;
        const recsocketid=onlineusers[receiver.clerkId];
        const sender = await prismaclient.user.findUnique({
    where: { id: msg.senderid },
    select: {
      id: true,
      name: true,
      avatar: true,
    },
  });
          if (!recsocketid || !sender) return;
       if (recsocketid && resp) {
        io.to(recsocketid).emit("new_notification",resp)
    io.to(recsocketid).emit("rec_notification", {
      resp: {
        ...resp,
        sender, 
      },
    });
  }
        
       
    })
    
})
server.listen(process.env.NEXT_PUBLIC_SOCKET_URL, () => {
  console.log("Socket server running on port 4000");
});