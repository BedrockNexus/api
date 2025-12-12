import dgram from 'dgram'

const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78
])

interface BedrockServerInfo {
  online: boolean
  edition?: string
  motd?: string
  protocolVersion?: number
  version?: string
  playerCount?: number
  maxPlayers?: number
  serverId?: string
  mapName?: string
  gamemode?: string
  port?: number
}

export function pingBedrockServer(host: string, port: number = 19132, timeout: number = 5000): Promise<BedrockServerInfo> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        socket.close()
      }
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve({ online: false })
    }, timeout)

    socket.on('error', () => {
      clearTimeout(timer)
      cleanup()
      resolve({ online: false })
    })

    socket.on('message', (msg) => {
      clearTimeout(timer)
      cleanup()

      try {
        // Response format: [1 byte ID][8 bytes time][8 bytes server GUID][16 bytes magic][string length][string data]
        if (msg[0] !== 0x1c) {
          resolve({ online: false })
          return
        }

        // Skip: ID(1) + time(8) + serverGUID(8) + magic(16) + stringLength(2)
        const dataOffset = 35
        const serverInfo = msg.slice(dataOffset).toString('utf8')
        const parts = serverInfo.split(';')

        // Format: Edition;MOTD;ProtocolVersion;Version;Players;MaxPlayers;ServerID;MapName;Gamemode;NintendoLimited;Port;Port6
        resolve({
          online: true,
          edition: parts[0],
          motd: parts[1],
          protocolVersion: parseInt(parts[2]) || undefined,
          version: parts[3],
          playerCount: parseInt(parts[4]) || 0,
          maxPlayers: parseInt(parts[5]) || 0,
          serverId: parts[6],
          mapName: parts[7],
          gamemode: parts[8],
          port: parseInt(parts[10]) || port
        })
      } catch {
        resolve({ online: true }) // Got response but couldn't parse
      }
    })

    // Build unconnected ping packet
    const packet = Buffer.alloc(33)
    packet[0] = 0x01 // Unconnected Ping
    
    // Timestamp (8 bytes)
    const time = BigInt(Date.now())
    packet.writeBigInt64BE(time, 1)
    
    // Magic (16 bytes)
    RAKNET_MAGIC.copy(packet, 9)
    
    // Client GUID (8 bytes)
    const clientGuid = BigInt(Math.floor(Math.random() * 0xffffffff))
    packet.writeBigInt64BE(clientGuid, 25)

    socket.send(packet, port, host)
  })
}
