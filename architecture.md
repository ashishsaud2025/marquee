# Marquee Architecture

## System Overview

```mermaid
graph TB
    subgraph Client["Frontend (Browser)"]
        UI["UI Layer<br/>index.html + style.css"]
        App["App Logic<br/>app.js"]
        Video["Video Player<br/>&lt;video&gt; or iframe"]
    end

    subgraph Server["Backend (Node.js)"]
        Express["Express.js<br/>HTTP Server"]
        Socket["Socket.io<br/>WebSocket Server"]
        Upload["Upload Handler<br/>multer"]
        URLHandler["URL Handler<br/>url-handler.js"]
        Library["Video Library<br/>library.json"]
    end

    subgraph Storage["File System"]
        Uploads["server/uploads/<br/>Video Files"]
    end

    subgraph External["External Services"]
        YouTube["YouTube API"]
        Vimeo["Vimeo API"]
        YTDLP["yt-dlp<br/>Direct Download"]
    end

    UI --> App
    App --> Video
    App <-->|Socket.io| Socket
    App -->|HTTP POST| Express
    Express --> Upload
    Express --> URLHandler
    Upload --> Uploads
    URLHandler --> YouTube
    URLHandler --> Vimeo
    URLHandler --> YTDLP
    YTDLP --> Uploads
    Express --> Library
```

## Room Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Landing: Open App
    
    Landing --> CreatingRoom: Host Enters Name
    Landing --> JoiningRoom: Guest Enters Code + Name
    
    CreatingRoom --> Room: Socket: create-room
    JoiningRoom --> Room: Socket: join-room
    
    state Room {
        [*] --> WaitingForVideo
        WaitingForVideo --> PlayingVideo: Host Sets Video
        PlayingVideo --> Paused: Socket: pause
        Paused --> PlayingVideo: Socket: play
        PlayingVideo --> PlayingVideo: Socket: seek
        Paused --> WaitingForVideo: Host Changes Video
        PlayingVideo --> WaitingForVideo: Host Changes Video
    }
    
    Room --> [*]: All Members Leave
    Room --> [*]: Browser Close
```

## Playback Sync Architecture

```mermaid
sequenceDiagram
    participant Host
    participant Server
    participant Guest1
    participant Guest2

    Note over Host, Guest2: Initial State: Video Loaded

    Host->>Server: socket.emit('play', {currentTime: 0})
    Server->>Guest1: socket.on('play') → play()
    Server->>Guest2: socket.on('play') → play()

    Note over Host, Guest2: Video Playing...

    Host->>Server: socket.emit('pause', {currentTime: 30.5})
    Server->>Guest1: socket.on('pause') → pause()
    Server->>Guest2: socket.on('pause') → pause()

    Host->>Server: socket.emit('seek', {currentTime: 45.0})
    Server->>Guest1: socket.on('seek') → seekTo()
    Server->>Guest2: socket.on('seek') → seekTo()

    Note over Guest1, Guest2: Every 5 seconds...
    Guest1->>Server: socket.emit('sync-request')
    Server-->>Guest1: {currentTime: 45.2, playing: false}
    Guest1->>Guest1: Correct drift if > 1.5s

    Guest2->>Server: socket.emit('sync-request')
    Server-->>Guest2: {currentTime: 45.2, playing: false}
    Guest2->>Guest2: Correct drift if > 1.5s
```

## Video Upload Flow

```mermaid
sequenceDiagram
    actor Host
    participant Browser
    participant Server
    participant FileSystem

    Host->>Browser: Drop video file
    Browser->>Server: POST /api/upload (multipart/form-data)
    Server->>Server: Validate MIME type (video/*)
    Server->>Server: Generate nanoid filename
    Server->>FileSystem: Write to uploads/{nanoid}.mp4
    Server->>Server: Update library.json
    Server-->>Browser: {filename, originalName, url, size}
    
    Browser->>Browser: socket.emit('set-video', data)
    Browser->>Server: Forward to room
    Server->>Server: Broadcast 'video-changed'
    Server-->>Browser: Load video in video element
```

## URL Video Flow

```mermaid
sequenceDiagram
    actor Host
    participant Browser
    participant Server
    participant URLHandler
    participant FileSystem

    Host->>Browser: Paste video URL
    
    alt YouTube/Vimeo URL
        Browser->>Server: POST /api/url {url}
        Server->>URLHandler: detectUrlType(url)
        URLHandler-->>Server: {type: 'iframe', platform, videoId}
        Server-->>Browser: {type: 'iframe', platform, videoId}
        Browser->>Browser: Load YouTube/Vimeo iframe player
        
    else Direct Video URL (.mp4, etc.)
        Browser->>Server: POST /api/url {url}
        Server->>URLHandler: detectUrlType(url)
        URLHandler-->>Server: {type: 'direct'}
        Server->>URLHandler: downloadVideo(url)
        URLHandler->>FileSystem: yt-dlp downloads to uploads/
        URLHandler-->>Server: {filename, originalName}
        Server-->>Browser: {type: 'upload', filename, url}
        Browser->>Browser: Load in video element
    end
    
    Browser->>Browser: socket.emit('set-video', metadata)
    Browser->>Server: Broadcast to room
    Server-->>Browser: 'video-changed' event
```

## Component Diagram

```mermaid
graph LR
    subgraph Frontend
        Landing["Landing Screen<br/>Host/Join Forms"]
        Room["Room Screen<br/>Video + Chat"]
        Player["Video Player<br/>&lt;video&gt; Element"]
        IframePlayer["Iframe Player<br/>YouTube/Vimeo"]
        Controls["Guest Controls<br/>Volume + Fullscreen"]
        Chat["Chat Panel<br/>Messages"]
        Library["Library Modal<br/>Video Selection"]
        URLInput["URL Input<br/>Paste Link"]
    end

    subgraph Backend
        Router["Express Router<br/>Static + API"]
        SocketIO["Socket.io Server<br/>Real-time Events"]
        UploadAPI["Upload API<br/>/api/upload"]
        URLAPI["URL API<br/>/api/url"]
        VideoAPI["Video API<br/>/api/videos"]
        RoomSync["Room Sync<br/>Playback State"]
    end

    Landing --> Router
    Room --> SocketIO
    Player --> SocketIO
    IframePlayer --> SocketIO
    Controls --> Player
    Library --> VideoAPI
    Library --> UploadAPI
    URLInput --> URLAPI
    Router --> UploadAPI
    Router --> URLAPI
    Router --> VideoAPI
    SocketIO --> RoomSync
```

## Room State Machine

```mermaid
stateDiagram-v2
    [*] --> Empty
    
    Empty --> HasHost: create-room
    HasHost --> HasHost+Guest: join-room
    
    state HasHost {
        [*] --> NoVideo
        NoVideo --> HasVideo: set-video
        HasVideo --> Playing: play
        Playing --> Paused: pause
        Paused --> Playing: play
        Playing --> Seeking: seek
        Paused --> Seeking: seek
        Seeking --> Playing: (playing)
        Seeking --> Paused: (paused)
    }

    HasHost+Guest --> HasHost: Guest leaves
    HasHost+Guest --> HasHost+Guest: Another joins
    HasHost --> HasGuest: Host leaves (promote)
    HasHost+Guest --> HasGuest: Host leaves (promote)
    
    HasGuest --> [*]: Last leaves
    
    state HasGuest {
        [*] --> WaitingForHost
        WaitingForHost --> HasVideo: set-video
    }
```

## Data Flow Diagrams

### Client-Server Communication

```mermaid
flowchart TB
    Client["Browser Client"]
    Server["Node.js Server"]
    
    subgraph HTTP["HTTP Requests"]
        Upload["POST /api/upload"]
        Videos["GET /api/videos"]
        URL["POST /api/url"]
        Delete["DELETE /api/videos/:id"]
    end
    
    subgraph SocketIO["Socket.io Events"]
        CreateRoom["create-room"]
        JoinRoom["join-room"]
        SetVideo["set-video"]
        Play["play"]
        Pause["pause"]
        Seek["seek"]
        Sync["sync-request"]
        Chat["chat-message"]
    end
    
    Client --> HTTP
    Client --> SocketIO
    HTTP --> Server
    SocketIO --> Server
```

### Video Playback Decision Tree

```mermaid
flowchart TD
    Start["New Video URL"] --> Detect{Detect URL Type}
    
    Detect -->|YouTube| ExtractYT[Extract YouTube ID]
    Detect -->|Vimeo| ExtractVM[Extract Vimeo ID]
    Detect -->|Direct .mp4| Download[Download via yt-dlp]
    Detect -->|Direct .m3u8| Proxy[Proxy HLS Stream]
    Detect -->|Unknown| Error[Show Error]
    
    ExtractYT --> IFrame["Load YouTube IFrame API"]
    ExtractVM --> IFrame
    Download --> Store["Save to uploads/"]
    Proxy --> Stream["Stream to Client"]
    
    IFrame --> Sync["Sync via Platform API"]
    Store --> Video["Load in &lt;video&gt;"]
    Stream --> Video
    
    Sync --> Ready["Ready to Play"]
    Video --> Ready
```

## Error Handling Flow

```mermaid
flowchart TD
    Action["User Action"] --> Validate{Validate}
    
    Validate -->|Invalid| Error["Show Error Message"]
    Validate -->|Valid| Process["Process Request"]
    
    Process --> ServerCheck{Server Check}
    
    ServerCheck -->|Room Not Found| Error
    ServerCheck -->|Not Host| Error
    ServerCheck -->|File Too Large| Error
    ServerCheck -->|Invalid Type| Error
    ServerCheck -->|Success| Broadcast["Broadcast Event"]
    
    Broadcast --> Clients["All Clients Update"]
    
    Error --> User["Display to User"]
```

## Socket.io Event Reference

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `create-room` | Client → Server | `{name}` | Create new room, become host |
| `join-room` | Client → Server | `{roomCode, name}` | Join existing room |
| `set-video` | Client → Server | `{filename, url, type, ...}` | Host sets current video |
| `play` | Client → Server | `{currentTime}` | Host plays video |
| `pause` | Client → Server | `{currentTime}` | Host pauses video |
| `seek` | Client → Server | `{currentTime}` | Host seeks video |
| `sync-request` | Client → Server | `{}` | Guest requests current state |
| `chat-message` | Client → Server | `{text}` | Send chat message |
| `video-changed` | Server → Client | `{video}` | Video source updated |
| `play` | Server → Client | `{currentTime}` | Play command from host |
| `pause` | Server → Client | `{currentTime}` | Pause command from host |
| `seek` | Server → Client | `{currentTime}` | Seek command from host |
| `sync-response` | Server → Client | `{currentTime, playing}` | Sync state response |
| `chat-message` | Server → Client | `{name, text, at}` | Broadcast chat message |
| `member-update` | Server → Client | `{memberCount, joined/left}` | Room membership changed |
| `promoted-to-host` | Server → Client | - | You are now the host |

## Performance Considerations

```mermaid
graph TD
    subgraph Optimizations
        A["HTTP Range Requests<br/>Express static serves with<br/>Accept-Ranges header"]
        B["Socket.io Polling Fallback<br/>WebSocket with HTTP long-polling"]
        C["Periodic Sync<br/>5-second drift correction<br/>prevents out-of-sync"]
        D["Suppress Events<br/>prevent echo loops<br/>when applying remote state"]
    end
    
    subgraph Limitations
        E["No Transcoding<br/>Videos served as-is"]
        F["No CDN<br/>Single server origin"]
        G["No Auth<br/>Anyone with code can join"]
        H["No Cleanup<br/>Uploads persist until manual delete"]
    end
```

## Deployment Architecture

```mermaid
graph TB
    subgraph Production["Production Setup"]
        LB["Load Balancer<br/>(Optional)"]
        App["Node.js App<br/>Port 3000"]
        Disk["Local Disk<br/>server/uploads/"]
    end
    
    subgraph Clients["Browser Clients"]
        C1["User 1<br/>(Host)"]
        C2["User 2<br/>(Guest)"]
        C3["User 3<br/>(Guest)"]
    end
    
    subgraph External["External"]
        YT["YouTube"]
        VM["Vimeo"]
    end
    
    C1 & C2 & C3 <-->|WebSocket| App
    C1 & C2 & C3 -->|HTTP| App
    App --> Disk
    App --> YT & VM
    LB --> App
```
