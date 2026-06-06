import { create } from "zustand";
import toast from "react-hot-toast";
import axiosInstance from "../../lib/axios";
import { getSocket } from "../../lib/socket";
import useAuthStore from "./useAuthStore";

/**
 * MEMORY LOCK QUEUE: 
 * Protects against async race conditions by ensuring rapid UI clicks
 * on emojis are processed in exact FIFO (First-In, First-Out) sequence per message.
 */
const reactionQueues = {};

const useChatStore = create((set, get) => ({
    users: [],
    selectedUser: null,
    messages: [],
    typingUsers: [],
    isUsersLoading: false,
    isMessagesLoading: false,
    hasMore: false,
    isLoadingMore: false,

    getUsers: async () => {
        set({ isUsersLoading: true });
        try {
            const res = await axiosInstance.get("/messages/users");
            set({ users: res.data });
        } catch (error) {
            toast.error(error.response?.data?.message || "Failed to load users");
        } finally {
            set({ isUsersLoading: false });
        }
    },

    searchUsers: async (query) => {
        try {
            const res = await axiosInstance.get(`/messages/search?q=${encodeURIComponent(query)}`);
            return res.data;
        } catch {
            toast.error("Search failed");
            return [];
        }
    },

    getMessages: async (userId) => {
        set({ isMessagesLoading: true });
        try {
            const res = await axiosInstance.get(`/messages/${userId}`);
            set({
                messages: res.data.messages,
                hasMore: res.data.hasMore,
            });
        } catch (error) {
            toast.error(error.response?.data?.message || "Failed to load messages");
        } finally {
            set({ isMessagesLoading: false });
        }
    },

    loadMoreMessages: async (userId) => {
        const { messages, isLoadingMore, hasMore } = get();
        if (isLoadingMore || !hasMore || messages.length === 0) return;

        set({ isLoadingMore: true });
        try {
            const oldestId = messages[0]._id;
            const res = await axiosInstance.get(
                `/messages/${userId}?before=${oldestId}&limit=30`
            );
            set({
                messages: [...res.data.messages, ...messages],
                hasMore: res.data.hasMore,
            });
        } catch (error) {
            toast.error("Failed to load older messages");
        } finally {
            set({ isLoadingMore: false });
        }
    },

    sendMessage: async (messageData) => {
        const { selectedUser, messages } = get();
        const { authUser } = useAuthStore.getState();
        if (!selectedUser || !authUser) return;

        // Optimistic UI Update
        const tempId = "temp-" + Date.now();
        const optimisticMsg = {
            _id: tempId,
            senderId: authUser._id,
            receiverId: selectedUser._id,
            ...messageData,
            reactions: [],
            status: "sent",
            createdAt: new Date().toISOString()
        };

        set({ messages: [...messages, optimisticMsg] });

        try {
            const res = await axiosInstance.post(`/messages/send/${selectedUser._id}`, messageData);
            
            // Replace temporary message with the real one from the server
            set((state) => ({
                messages: state.messages.map(m => m._id === tempId ? res.data : m)
            }));

            // Update sidebar: lastMessage for this user
            set((state) => ({
                users: state.users.map((u) =>
                    u._id === selectedUser._id
                        ? {
                              ...u,
                              lastMessage: {
                                  _id: res.data._id,
                                  message: res.data.message,
                                  image: !!res.data.image,
                                  audio: !!res.data.audio,
                                  senderId: res.data.senderId,
                                  createdAt: res.data.createdAt,
                              },
                          }
                        : u
                ),
            }));
        } catch (error) {
            toast.error(error.response?.data?.message || "Failed to send message");
            // Revert optimistic update on failure
            set((state) => ({
                messages: state.messages.filter(m => m._id !== tempId)
            }));
        }
    },

    deleteMessage: async (messageId) => {
        try {
            await axiosInstance.delete(`/messages/${messageId}`);
            set({ messages: get().messages.filter((m) => m._id !== messageId) });
            toast.success("Message deleted");
        } catch (error) {
            toast.error(error.response?.data?.message || "Failed to delete");
        }
    },

    /**
     * ATOMIC ACTION: addReaction
     * Pushes reaction requests into an isolated queue to prevent UI flickering
     * and database overwrite race conditions during rapid spam clicking.
     */
    addReaction: async (messageId, emoji) => {
        // 1. Initialize local queue for this specific message
        if (!reactionQueues[messageId]) {
            reactionQueues[messageId] = [];
        }

        // 2. Define the exact network mutation task closure
        const executeReactionTask = async () => {
            try {
                const res = await axiosInstance.post(`/messages/${messageId}/react`, { emoji });
                set((state) => ({
                    messages: state.messages.map((msg) =>
                        msg._id === messageId ? { ...msg, reactions: res.data } : msg
                    ),
                }));
            } catch (error) {
                toast.error("Failed to synchronize reaction");
            }
        };

        // 3. Push this task thread into the message's execution line
        reactionQueues[messageId].push(executeReactionTask);

        // 4. Start the sequencer if this is the only pending payload
        if (reactionQueues[messageId].length === 1) {
            while (reactionQueues[messageId].length > 0) {
                const currentTask = reactionQueues[messageId][0];
                await currentTask(); // Enforce strict sequential execution
                reactionQueues[messageId].shift(); // Clear task upon resolution
            }
            // Free the memory map once queue is fully drained
            delete reactionQueues[messageId];
        }
    },

    markMessagesAsSeen: async (senderId) => {
        try {
            await axiosInstance.put("/messages/mark-seen", { senderId });
            set((state) => ({
                messages: state.messages.map((msg) =>
                    msg.senderId === senderId ? { ...msg, status: "seen" } : msg
                ),
            }));
        } catch (error) {
            console.log("Failed to mark messages as seen", error);
        }
    },

    subscribeToMessages: () => {
        const socket = getSocket();
        if (!socket) return;

        socket.on("newMessage", (message) => {
            const { selectedUser, messages, users } = get();
            const authUser = useAuthStore.getState().authUser;

            const msgSenderId   = message.senderId?.toString();
            const msgReceiverId = message.receiverId?.toString();
            const selUserId     = selectedUser?._id?.toString();
            const authUserId2   = authUser?._id?.toString();

            const isFromSelectedUser = !!selUserId && msgSenderId === selUserId;
            const isToSelectedUser   = !!selUserId && msgSenderId === authUserId2 && msgReceiverId === selUserId;
            
            if (isFromSelectedUser || isToSelectedUser) {
                const msgExists = messages.some(m => m._id?.toString() === message._id?.toString());
                if (!msgExists) {
                    set({ messages: [...messages, message] });
                }
                
                if (isFromSelectedUser) {
                    get().markMessagesAsSeen(selectedUser._id);
                }
            }

            const iSentThis = msgSenderId === authUserId2;
            const otherUserId = iSentThis ? msgReceiverId : msgSenderId;
            const otherUserInSidebar = users.find((u) => u._id?.toString() === otherUserId);

            if (otherUserInSidebar) {
                set((state) => ({
                    users: state.users.map((u) =>
                        u._id?.toString() === otherUserId
                            ? {
                                  ...u,
                                  lastMessage: {
                                      _id: message._id,
                                      message: message.message,
                                      image: !!message.image,
                                      audio: !!message.audio,
                                      senderId: message.senderId,
                                      createdAt: message.createdAt,
                                  },
                                  unreadCount:
                                      iSentThis || state.selectedUser?._id?.toString() === otherUserId
                                          ? u.unreadCount
                                          : (u.unreadCount || 0) + 1,
                              }
                            : u
                    ),
                }));
            } else {
                get().getUsers();
            }

            if (document.visibilityState !== "visible" && Notification.permission === "granted") {
                const sender = users.find((u) => u._id?.toString() === msgSenderId);
                const senderName = sender?.name || "Someone";
                const body = message.message || (message.audio ? "🎤 Voice message" : "📷 Image");
                const n = new Notification(`New message from ${senderName}`, {
                    body,
                    icon: "/favicon.png",
                });
                n.onclick = () => window.focus();
            }
        });

        socket.on("deleteMessage", (messageId) => {
            set({ messages: get().messages.filter((m) => m._id !== messageId) });
        });

        socket.on("userTyping", ({ senderId }) => {
            set((state) => ({
                typingUsers: [...new Set([...state.typingUsers, senderId])],
            }));
        });

        socket.on("userStoppedTyping", ({ senderId }) => {
            set((state) => ({
                typingUsers: state.typingUsers.filter((id) => id !== senderId),
            }));
        });

        socket.on("messagesSeen", ({ receiverId }) => {
            set((state) => ({
                messages: state.messages.map((msg) =>
                    msg.receiverId === receiverId ? { ...msg, status: "seen" } : msg
                ),
            }));
        });

        socket.on("messagesDelivered", ({ receiverId }) => {
            set((state) => ({
                messages: state.messages.map((msg) =>
                    msg.receiverId === receiverId && msg.status === "sent" 
                    ? { ...msg, status: "delivered" } 
                    : msg
                ),
            }));
        });

        socket.on("messageReacted", ({ messageId, reactions }) => {
            set((state) => ({
                messages: state.messages.map((msg) =>
                    msg._id === messageId ? { ...msg, reactions } : msg
                ),
            }));
        });
    },

    unsubscribeFromMessages: () => {
        const socket = getSocket();
        if (socket) {
            socket.off("newMessage");
            socket.off("deleteMessage");
            socket.off("userTyping");
            socket.off("userStoppedTyping");
            socket.off("messagesSeen");
            socket.off("messagesDelivered");
            socket.off("messageReacted");
        }
    },

    searchTextMessages: async (userId, query) => {
        try {
            const res = await axiosInstance.get(`/messages/search-text/${userId}?q=${encodeURIComponent(query)}`);
            return res.data;
        } catch {
            toast.error("Text search failed");
            return [];
        }
    },

    setSelectedUser: (user) => {
        if (!user) return set({ selectedUser: null, messages: [] });
        const current = get().selectedUser;
        if (current?._id === user?._id) return;

        set((state) => ({
            selectedUser: user,
            messages: [],
            users: state.users.map((u) =>
                u._id === user._id ? { ...u, unreadCount: 0 } : u
            ),
        }));
    },
}));

export default useChatStore;