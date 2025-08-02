console.log('YouTube Auto Transcriber content script loaded')

let recordingIndicator: HTMLElement | null = null
let mediaRecorder: MediaRecorder | null = null
let audioStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message)
  
  if (message.type === 'ping') {
    sendResponse({ success: true, message: 'Content script is ready' })
  } else if (message.type === 'recordingState') {
    updateRecordingIndicator(message.isRecording)
    sendResponse({ success: true })
  } else if (message.type === 'startRecording') {
    console.log('Starting screen capture recording...')
    startScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'stopRecording') {
    console.log('Stopping screen capture recording...')
    stopScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'getRecordingState') {
    const isRecording = mediaRecorder?.state === 'recording'
    sendResponse({ isRecording })
  }
  
  return true
})

async function startScreenCapture() {
  try {
    console.log('Requesting screen capture with audio...')
    
    // Show instruction to user
    showInstructionModal()
    
    // Use getDisplayMedia to capture screen with audio
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // Required for getDisplayMedia
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100
      }
    })
    
    console.log('Screen capture successful, tracks:', stream.getTracks().map(t => ({ 
      kind: t.kind, 
      enabled: t.enabled, 
      label: t.label,
      settings: t.getSettings ? t.getSettings() : 'N/A'
    })))
    
    // Check if we have audio
    const audioTracks = stream.getAudioTracks()
    const videoTracks = stream.getVideoTracks()
    
    console.log('Audio tracks:', audioTracks.length)
    console.log('Video tracks:', videoTracks.length)
    
    if (audioTracks.length === 0) {
      throw new Error('No audio captured. Please make sure to check "Share tab audio" when prompted.')
    }

    // Log audio track settings
    audioTracks.forEach((track, index) => {
      console.log(`Audio track ${index} settings:`, track.getSettings())
      console.log(`Audio track ${index} capabilities:`, track.getCapabilities())
    })
    
    // Create audio-only stream
    const audioOnlyStream = new MediaStream(audioTracks)
    
    // Set up audio analysis
    try {
      audioContext = new AudioContext({ sampleRate: 44100 })
      const source = audioContext.createMediaStreamSource(audioOnlyStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      
      // Start monitoring audio levels
      monitorAudioLevels()
      
      console.log('Audio context created, sample rate:', audioContext.sampleRate)
    } catch (error) {
      console.error('Failed to create audio context:', error)
    }
    
    // Try different audio formats, prioritizing ones easier to decode
    const supportedTypes = [
      'audio/wav', // Try WAV first (easier to decode)
      'audio/webm;codecs=pcm', // PCM in WebM container
      'audio/ogg;codecs=opus', // Ogg container might work better
      'audio/mp4', // MP4 container
      'audio/webm;codecs=opus', // WebM with Opus as fallback
      'audio/webm' // Generic WebM
    ]
    
    // Log which types are supported
    supportedTypes.forEach(type => {
      console.log(`${type}: ${MediaRecorder.isTypeSupported(type) ? 'SUPPORTED' : 'NOT SUPPORTED'}`)
    })
    
    let selectedType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type))
    console.log('Selected audio type:', selectedType)
    
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: 128000
    }
    
    if (selectedType) {
      options.mimeType = selectedType
    }
    
    console.log('MediaRecorder options:', options)
    
    mediaRecorder = new MediaRecorder(audioOnlyStream, options)
    
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        console.log(`Audio chunk available: ${event.data.size} bytes, type: ${event.data.type}`)
        
        try {
          // First, try to convert to LINEAR16 PCM
          const linear16Data = await convertBlobToLinear16(event.data)
          
          if (linear16Data) {
            console.log(`Successfully converted to LINEAR16: ${linear16Data.length} characters (base64)`)
            
            // Send LINEAR16 data to background script
            chrome.runtime.sendMessage({
              type: 'audioChunk',
              audioData: linear16Data,
              size: event.data.size,
              mimeType: 'audio/linear16',
              encoding: 'LINEAR16',
              sampleRate: audioContext?.sampleRate || 44100
            })
          } else {
            console.log('LINEAR16 conversion failed, sending original blob as fallback')
            
            // Fallback: send the original blob
            const base64Data = await blobToBase64(event.data)
            chrome.runtime.sendMessage({
              type: 'audioChunk',
              audioData: base64Data,
              size: event.data.size,
              mimeType: event.data.type,
              encoding: 'WEBM_OPUS'
            })
          }
          
        } catch (error) {
          console.error('Failed to process audio chunk:', error)
          
          // Last resort: try sending the original blob
          try {
            const base64Data = await blobToBase64(event.data)
            chrome.runtime.sendMessage({
              type: 'audioChunk',
              audioData: base64Data,
              size: event.data.size,
              mimeType: event.data.type,
              encoding: 'ORIGINAL'
            })
          } catch (fallbackError) {
            console.error('Even fallback failed:', fallbackError)
          }
        }
      } else {
        console.warn('Received empty audio chunk')
      }
    }
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event)
      chrome.runtime.sendMessage({
        type: 'recordingError',
        error: 'MediaRecorder error occurred'
      })
    }
    
    mediaRecorder.onstop = () => {
      console.log('MediaRecorder stopped')
    }
    
    mediaRecorder.onstart = () => {
      console.log('MediaRecorder started successfully')
    }
    
    // Start recording in 10-second chunks
    console.log('Starting MediaRecorder...')
    mediaRecorder.start(10000)
    audioStream = stream
    
    // Stop video tracks to save resources (we only need audio)
    videoTracks.forEach(track => track.stop())
    
    // Hide instruction modal
    hideInstructionModal()
    
    console.log('Audio recording started successfully')
    chrome.runtime.sendMessage({ type: 'recordingStarted' })
    
    // Handle stream end (user stops sharing)
    audioTracks.forEach(track => {
      track.addEventListener('ended', () => {
        console.log('Audio track ended (user stopped sharing)')
        stopScreenCapture()
      })
    })
    
  } catch (error) {
    console.error('Failed to start screen capture:', error)
    hideInstructionModal()
    
    let errorMessage = error.message
    if (error.name === 'NotAllowedError') {
      errorMessage = 'Screen sharing was denied. Please allow screen sharing and make sure to select "Share tab audio".'
    } else if (error.name === 'NotFoundError') {
      errorMessage = 'No screen sharing source found. Please try again.'
    }
    
    chrome.runtime.sendMessage({
      type: 'recordingError',
      error: errorMessage
    })
  }
}

async function convertBlobToLinear16(blob: Blob): Promise<string | null> {
  try {
    if (!audioContext) {
      console.error('No audio context available for conversion')
      return null
    }
    
    console.log(`Converting blob to LINEAR16: ${blob.size} bytes, type: ${blob.type}`)
    
    // Convert blob to array buffer
    const arrayBuffer = await blob.arrayBuffer()
    console.log(`Array buffer size: ${arrayBuffer.byteLength} bytes`)
    
    // Try different approaches based on the blob type
    let audioBuffer: AudioBuffer
    
    if (blob.type.includes('wav')) {
      console.log('Attempting to decode WAV audio...')
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0))
    } else if (blob.type.includes('webm') || blob.type.includes('opus')) {
      console.log('Attempting to decode WebM/Opus audio...')
      try {
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0))
      } catch (webmError) {
        console.error('WebM/Opus decoding failed:', webmError)
        
        // Try a workaround: create a temporary audio element
        console.log('Trying audio element workaround...')
        return await convertUsingAudioElement(blob)
      }
    } else {
      console.log('Attempting to decode unknown audio format...')
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0))
    }
    
    console.log(`Decoded audio: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels} channels, ${audioBuffer.sampleRate}Hz`)
    
    // Get the raw PCM data from the first channel
    const channelData = audioBuffer.getChannelData(0)
    
    // Check for silence
    const rms = Math.sqrt(channelData.reduce((sum, sample) => sum + sample * sample, 0) / channelData.length)
    console.log(`Audio RMS level: ${rms.toFixed(6)} ${rms < 0.001 ? '(likely silent)' : '(has audio signal)'}`)
    
    if (rms < 0.001) {
      console.warn('Audio appears to be silent, but proceeding with conversion anyway')
    }
    
    // Convert float32 samples to int16 (LINEAR16 format)
    const int16Data = new Int16Array(channelData.length)
    for (let i = 0; i < channelData.length; i++) {
      // Convert from [-1, 1] float to [-32768, 32767] int16
      const sample = Math.max(-1, Math.min(1, channelData[i]))
      int16Data[i] = sample < 0 ? sample * 32768 : sample * 32767
    }
    
    console.log(`Converted ${channelData.length} samples to int16`)
    
    // Convert to base64
    const uint8Array = new Uint8Array(int16Data.buffer)
    let binary = ''
    for (let i = 0; i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i])
    }
    
    const base64 = btoa(binary)
    console.log(`Generated base64 string: ${base64.length} characters`)
    
    return base64
    
  } catch (error) {
    console.error('Failed to convert blob to LINEAR16:', error)
    return null
  }
}

async function convertUsingAudioElement(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      console.log('Trying audio element approach...')
      
      const audio = new Audio()
      const url = URL.createObjectURL(blob)
      
      audio.onloadeddata = async () => {
        try {
          console.log(`Audio element loaded: duration=${audio.duration}s`)
          
          if (!audioContext) {
            resolve(null)
            return
          }
          
          // Create a media element source
          const source = audioContext.createMediaElementSource(audio)
          
          // Create a destination to capture the audio
          const destination = audioContext.createMediaStreamDestination()
          source.connect(destination)
          
          // This approach is complex and may not work reliably
          // For now, just return null to fall back to original format
          console.log('Audio element approach is complex, falling back to original format')
          resolve(null)
          
        } catch (error) {
          console.error('Audio element processing failed:', error)
          resolve(null)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      
      audio.onerror = (error) => {
        console.error('Audio element failed to load:', error)
        URL.revokeObjectURL(url)
        resolve(null)
      }
      
      audio.src = url
      
    } catch (error) {
      console.error('Audio element approach failed:', error)
      resolve(null)
    }
  })
}

function monitorAudioLevels() {
  if (!analyser) return
  
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)
  
  function checkAudio() {
    if (!analyser) return
    
    analyser.getByteFrequencyData(dataArray)
    
    // Calculate average volume
    const average = dataArray.reduce((sum, value) => sum + value, 0) / bufferLength
    
    // Log audio levels every 5 seconds
    if (Math.random() < 0.1) { // ~10% chance each frame
      console.log(`Audio level: ${average.toFixed(2)}/255, non-zero frequencies: ${dataArray.filter(v => v > 0).length}/${bufferLength}`)
    }
    
    // Continue monitoring
    requestAnimationFrame(checkAudio)
  }
  
  checkAudio()
}

function stopScreenCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    mediaRecorder = null
  }
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop())
    audioStream = null
  }
  
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyser = null
  }
  
  hideInstructionModal()
  
  console.log('Audio recording stopped')
  chrome.runtime.sendMessage({ type: 'recordingStopped' })
}

function showInstructionModal() {
  // Remove existing modal if any
  hideInstructionModal()
  
  const modal = document.createElement('div')
  modal.id = 'transcriber-instruction-modal'
  modal.innerHTML = `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif;
    ">
      <div style="
        background: white;
        padding: 30px;
        border-radius: 12px;
        max-width: 500px;
        text-align: center;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      ">
        <h2 style="margin: 0 0 20px 0; color: #1a73e8;">🎤 Audio Capture Required</h2>
        <p style="margin: 0 0 20px 0; color: #333; line-height: 1.5;">
          To transcribe this YouTube video, please:
        </p>
        <ol style="text-align: left; color: #333; line-height: 1.6; margin: 0 0 20px 0;">
          <li>In the sharing dialog, click <strong>"Tab"</strong> at the top</li>
          <li>Select the <strong>YouTube tab</strong> you want to transcribe</li>
          <li>Make sure to check <strong>"Share tab audio"</strong> at the bottom</li>
          <li>Click <strong>"Share"</strong></li>
        </ol>
        <div style="background: #f0f8ff; padding: 10px; border-radius: 6px; margin: 0 0 20px 0; font-size: 13px; color: #333;">
          <strong>💡 Tip:</strong> If you don't see "Tab" option, select "Entire screen" and still check "Share system audio"
        </div>
        <p style="margin: 0; color: #666; font-size: 14px;">
          The screen sharing dialog should appear shortly...
        </p>
      </div>
    </div>
  `
  
  document.body.appendChild(modal)
}

function hideInstructionModal() {
  const modal = document.getElementById('transcriber-instruction-modal')
  if (modal) {
    modal.remove()
  }
}

function updateRecordingIndicator(isRecording: boolean) {
  if (isRecording && !recordingIndicator) {
    recordingIndicator = document.createElement('div')
    recordingIndicator.innerHTML = '🎤 Recording Audio<br><small>Click to stop</small>'
    recordingIndicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #ea4335, #fbbc04);
      color: white;
      padding: 15px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: system-ui, -apple-system, sans-serif;
      animation: pulse 2s infinite;
      cursor: pointer;
      text-align: center;
      line-height: 1.3;
    `
    
    // Add CSS animation
    if (!document.querySelector('#transcriber-styles')) {
      const style = document.createElement('style')
      style.id = 'transcriber-styles'
      style.textContent = `
        @keyframes pulse {
          0% { transform: scale(1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
          50% { transform: scale(1.05); box-shadow: 0 6px 16px rgba(0,0,0,0.25); }
          100% { transform: scale(1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        }
      `
      document.head.appendChild(style)
    }
    
    // Click to stop recording
    recordingIndicator.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'stopRecording' })
    })
    
    document.body.appendChild(recordingIndicator)
    
  } else if (!isRecording && recordingIndicator) {
    recordingIndicator.remove()
    recordingIndicator = null
  }
}

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'contentScriptReady' })
