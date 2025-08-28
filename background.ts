// File: background.ts
import { Storage } from "@plasmohq/storage"

const storage = new Storage()

interface TranscriptionEntry {
  timestamp: string
  text: string
  language?: string
  chunkNumber: number
}

class UniversalTranscriptionService {
  private isRecording = false
  private mediaRecorder: MediaRecorder | null = null
  private audioBuffer: Blob[] = []
  private isProcessing = false
  private chunkCount = 0
  private transcriptionData: TranscriptionEntry[] = []
  private recordingStartTime: number = 0
  private lastChunkTime: number = 0
  private currentTabId: number | null = null

  // Public getter to check recording state
  get recording(): boolean {
    return this.isRecording
  }

  // Public getter and setter for current tab ID
  get currentTab(): number | null {
    return this.currentTabId
  }
  
  set currentTab(tabId: number) {
    this.currentTabId = tabId
  }

  // Public method to set recording state
  setRecordingState(isRecording: boolean) {
    this.isRecording = isRecording
  }

  // Check if required APIs are available
  private checkApiAvailability(): { available: boolean; missing: string[] } {
    const missing: string[] = []
    
    if (!chrome.tabCapture) {
      missing.push('chrome.tabCapture')
    } else if (!chrome.tabCapture.capture) {
      missing.push('chrome.tabCapture.capture')
    }
    
    if (!chrome.downloads) {
      missing.push('chrome.downloads')
    }
    
    if (!chrome.notifications) {
      missing.push('chrome.notifications')
    }
    
    return {
      available: missing.length === 0,
      missing
    }
  }

  async startRecording(tabId: number) {
    if (this.isRecording) return

    const apiKey = await storage.get("google_api_key")
    if (!apiKey) {
      this.showNotification('API Key Required', 'Please add your Google Cloud API key in the extension popup')
      return
    }

    try {
      console.log('Starting recording for tab:', tabId)
      
      // Make sure we're capturing the right tab
      this.currentTabId = tabId
      
      // First, let's check if the tab is still valid
      const tab = await chrome.tabs.get(tabId)
      console.log('Target tab info:', tab.url, tab.status)
      
      if (!tab.url?.includes('youtube.com')) {
        throw new Error('Selected tab is not a YouTube page')
      }
      
      // Test if content script is reachable
      console.log('Testing content script connection...')
      try {
        const pingResponse = await this.sendMessageToTabWithResponse(tabId, { type: 'ping' })
        console.log('Content script ping response:', pingResponse)
        
        if (!pingResponse || !pingResponse.success) {
          throw new Error('Content script is not responding to ping')
        }
      } catch (pingError) {
        console.error('Content script ping failed:', pingError)
        throw new Error('Content script is not reachable. Please refresh the YouTube page and try again.')
      }
      
      this.recordingStartTime = Date.now()
      this.isRecording = true
      this.transcriptionData = []
      this.chunkCount = 0
      
      // Notify content script to start recording
      console.log('Sending startRecording message to content script...')
      this.sendMessageToTab(tabId, { type: 'startRecording' })
      
      // Send message to popup about recording state
      chrome.runtime.sendMessage({ type: 'recordingState', isRecording: true })
      
      // Show notification that recording started
      this.showNotification('Recording Started', 'YouTube transcription starting. You may see a screen share prompt.')
      
      console.log('Recording initiated via content script')
      
    } catch (error) {
      console.error('Failed to start recording:', error)
      this.handleRecordingError(error)
    }
  }

  private handleRecordingError(error: any) {
    this.isRecording = false
    
    const errorMessage = error.message || 'Unknown error occurred'
    console.error('Recording error:', errorMessage)
    
    // Send error message to popup
    chrome.runtime.sendMessage({ 
      type: 'recordingError', 
      error: errorMessage
    })
    
    // Show notification
    this.showNotification('Recording Error', errorMessage)
  }

  private showNotification(title: string, message: string) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: title,
        message: message
      })
    } catch (error) {
      console.warn('Failed to show notification:', error)
    }
  }

  private sendMessageToTab(tabId: number, message: any) {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Failed to send message to tab:', chrome.runtime.lastError.message)
          
          // If it's a connection error, the content script might have been reloaded
          if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
            console.log('Content script connection lost. This usually means:')
            console.log('- The YouTube page was refreshed')
            console.log('- The user navigated to a different page')
            console.log('- The content script was reloaded')
            
            // Try to re-establish connection by checking if tab still exists
            chrome.tabs.get(tabId, (tab) => {
              if (chrome.runtime.lastError) {
                console.log('Tab no longer exists, stopping recording')
                this.stopRecording()
              } else if (tab.url?.includes('youtube.com')) {
                console.log('Tab still exists, content script may need to be re-injected')
                // The content script should re-inject itself on page load
              }
            })
          }
        }
      })
    } catch (error) {
      console.log('Error sending message to tab:', error)
    }
  }

  private async sendMessageToTabWithResponse(tabId: number, message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve(response)
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  async processWebMChunk(audioBlob: Blob, timestamp: string) {
    this.chunkCount++
    console.log(`Processing WebM chunk ${this.chunkCount} at ${timestamp}, size: ${audioBlob.size} bytes`)
    console.log(`Audio blob type: ${audioBlob.type}`)

    // Add to buffer for context
    this.audioBuffer.push(audioBlob)
    
    // Keep only last 3 chunks for context (prevents memory issues)
    if (this.audioBuffer.length > 3) {
      this.audioBuffer.shift()
    }

    // Process the current chunk with context from previous chunks
    await this.processChunkWithContext(audioBlob, timestamp)
  }

  private async processChunkWithContext(audioBlob: Blob, timestamp: string) {
    try {
             const apiKey = await storage.get("google_api_key")
      if (!apiKey) {
        console.error('No API key available')
        return
      }

      console.log('API key available, length:', apiKey.length)
      
      // Convert blob to base64
      const base64Data = await this.blobToBase64(audioBlob)
      console.log('Base64 data length:', base64Data.length, 'characters')
      console.log('First 100 chars of base64:', base64Data.substring(0, 100))

      // Use explicit configuration that works with WebM Opus:
      // - encoding: WEBM_OPUS (what MediaRecorder produces)
      // - sampleRateHertz: 48000 (WebM Opus standard)
      // - audioChannelCount: 2 (stereo, matches MediaRecorder output)
      // - Enhanced model for better video transcription
      const requestBody = {
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000, // Explicitly set to WebM Opus standard
          audioChannelCount: 2,    // Explicitly set to stereo
          enableSeparateRecognitionPerChannel: false,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'video',
          useEnhanced: true,       // Use enhanced model for video content
          maxAlternatives: 1
        },
        audio: {
          content: base64Data
        }
      }

      // If we're using Vorbis codec, adjust the configuration
      if (audioBlob.type.includes('vorbis')) {
        console.log('Detected Vorbis codec, using VORBIS encoding...')
        requestBody.config.encoding = 'WEBM_VORBIS'
        // Vorbis typically works better with auto-detection
        delete requestBody.config.sampleRateHertz
        delete requestBody.config.audioChannelCount
      }

      console.log('Sending audio to Google Speech API with config:', requestBody.config)
      console.log('Audio data size:', audioBlob.size, 'bytes')
      console.log('Audio data type:', audioBlob.type)

      const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })

      console.log('Google Speech API response status:', response.status)
      console.log('Response headers:', Object.fromEntries(response.headers.entries()))

      if (response.ok) {
        const result = await response.json()
        console.log('Google Speech API response for WebM:', result)
        console.log('Response details:')
        console.log('- Status:', response.status)
        console.log('- Results count:', result.results ? result.results.length : 'undefined')
        console.log('- Total billed time:', result.totalBilledTime)
        console.log('- Request ID:', result.requestId)

        if (result.results && result.results.length > 0 && result.results[0].alternatives) {
          const transcription = result.results[0].alternatives[0].transcript
          const confidence = result.results[0].alternatives[0].confidence || 0

          if (transcription && transcription.trim().length > 0) {
            const entry: TranscriptionEntry = {
              timestamp,
              text: transcription.trim(),
              language: 'en-US',
              chunkNumber: this.chunkCount
            }

            this.transcriptionData.push(entry)
            console.log(`✅ WebM [${timestamp}] (confidence: ${confidence.toFixed(2)}): ${transcription}`)

            // Send message to popup about processed chunk
            chrome.runtime.sendMessage({
              type: 'chunkProcessed',
              chunkNumber: this.chunkCount,
              language: 'en-US',
              text: transcription,
              confidence: confidence
            })

            // Auto-save every 5 successful chunks
            if (this.transcriptionData.length % 5 === 0) {
              await this.saveTranscriptionFile()
            }
          } else {
            console.log(`WebM Chunk ${this.chunkCount}: Empty transcription result`)
            console.log('This suggests the API processed the audio but found no speech content')
          }
        } else {
          console.log(`❌ WebM Chunk ${this.chunkCount}: No transcription results`)
          console.log('Possible reasons:')
          console.log('- Audio contains only background noise/music')
          console.log('- Audio chunk is too short for reliable recognition')
          console.log('- Audio format is not properly decoded by the API')
          console.log('- Chunk boundaries cut through speech')
          
          if (result) {
            console.log('Full WebM API response for debugging:', JSON.stringify(result, null, 2))
          }

          // If we get a 200 response but no results, try one more time without sample rate specification
          console.log('Got 200 response but no results. Trying without sample rate specification...')
          const noSampleRateBody = {
            config: {
              encoding: 'WEBM_OPUS',
              // No sampleRateHertz - let API infer from audio
              audioChannelCount: 2,
              enableSeparateRecognitionPerChannel: false,
              languageCode: 'en-US',
              enableAutomaticPunctuation: true,
              model: 'video',
              useEnhanced: true,
              maxAlternatives: 1
            },
            audio: { content: base64Data }
          }

          const noSampleRateResp = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(noSampleRateBody)
          })

          console.log('No sample rate fallback status:', noSampleRateResp.status)
          if (noSampleRateResp.ok) {
            const noSampleRateResult = await noSampleRateResp.json()
            console.log('No sample rate fallback response:', noSampleRateResult)

            // Process the fallback result if it has transcription
            if (noSampleRateResult.results && noSampleRateResult.results.length > 0 && noSampleRateResult.results[0].alternatives) {
              const transcription = noSampleRateResult.results[0].alternatives[0].transcript
              const confidence = noSampleRateResult.results[0].alternatives[0].confidence || 0

              if (transcription && transcription.trim().length > 0) {
                const entry: TranscriptionEntry = {
                  timestamp,
                  text: transcription.trim(),
                  language: 'en-US',
                  chunkNumber: this.chunkCount
                }

                this.transcriptionData.push(entry)
                console.log(`✅ WebM No-Sample-Rate Fallback [${timestamp}] (confidence: ${confidence.toFixed(2)}): ${transcription}`)

                // Send message to popup about processed chunk
                chrome.runtime.sendMessage({
                  type: 'chunkProcessed',
                  chunkNumber: this.chunkCount,
                  language: 'en-US',
                  text: transcription,
                  confidence: confidence
                })

                // Auto-save every 5 successful chunks
                if (this.transcriptionData.length % 5 === 0) {
                  await this.saveTranscriptionFile()
                }
              }
            }
          } else {
            console.log('No sample rate fallback failed:', await noSampleRateResp.text())
          }
        }
      } else {
        const errorText = await response.text()
        console.error('Google Speech API error for WebM:', response.status, errorText)
        console.log('Error analysis:')
        console.log('- HTTP status:', response.status)
        console.log('- Error message:', errorText)

        // If we see a channel count complaint, try once more with channelCount unset.
        if (errorText.includes('audio_channel_count')) {
          console.log('Retrying without audioChannelCount to let API infer...')
          const retryBody = {
            config: {
              encoding: 'WEBM_OPUS',
              languageCode: 'en-US',
              enableAutomaticPunctuation: true,
              model: 'video',
              useEnhanced: true,
              maxAlternatives: 1
            },
            audio: { content: base64Data }
          }
          const retryResp = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(retryBody)
          })
          console.log('Retry status:', retryResp.status)
          if (retryResp.ok) {
            const retryResult = await retryResp.json()
            console.log('Retry response:', retryResult)
          } else {
            console.log('Retry failed:', await retryResp.text())
          }
        }

        // If we see a sample rate complaint, try with 44.1kHz as fallback
        if (errorText.includes('sample rate') || errorText.includes('Opus sample rate')) {
          console.log('Retrying with 44.1kHz sample rate as fallback...')
          const fallbackBody = {
            config: {
              encoding: 'WEBM_OPUS',
              sampleRateHertz: 44100, // Try 44.1kHz as fallback
              audioChannelCount: 2,
              enableSeparateRecognitionPerChannel: false,
              languageCode: 'en-US',
              enableAutomaticPunctuation: true,
              model: 'video',
              useEnhanced: true,
              maxAlternatives: 1
            },
            audio: { content: base64Data }
          }
          const fallbackResp = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fallbackBody)
          })
          console.log('Fallback status:', fallbackResp.status)
          if (fallbackResp.ok) {
            const fallbackResult = await fallbackResp.json()
            console.log('Fallback response:', fallbackResult)

            // Process the fallback result if it has transcription
            if (fallbackResult.results && fallbackResult.results.length > 0 && fallbackResult.results[0].alternatives) {
              const transcription = fallbackResult.results[0].alternatives[0].transcript
              const confidence = fallbackResult.results[0].alternatives[0].confidence || 0

              if (transcription && transcription.trim().length > 0) {
                const entry: TranscriptionEntry = {
                  timestamp,
                  text: transcription.trim(),
                  language: 'en-US',
                  chunkNumber: this.chunkCount
                }

                this.transcriptionData.push(entry)
                console.log(`✅ WebM Fallback [${timestamp}] (confidence: ${confidence.toFixed(2)}): ${transcription}`)

                // Send message to popup about processed chunk
                chrome.runtime.sendMessage({
                  type: 'chunkProcessed',
                  chunkNumber: this.chunkCount,
                  language: 'en-US',
                  text: transcription,
                  confidence: confidence
                })

                // Auto-save every 5 successful chunks
                if (this.transcriptionData.length % 5 === 0) {
                  await this.saveTranscriptionFile()
                }
              }
            }
          } else {
            console.log('Fallback failed:', await fallbackResp.text())
          }
        }
      }
    } catch (error) {
      console.error('Error processing WebM chunk:', error)
    }
  }

  async stopRecording() {
    console.log('stopRecording called, isRecording:', this.isRecording)
    if (!this.isRecording) {
      console.log('Not recording, returning early')
      return
    }

    console.log('Stopping recording, transcription data length:', this.transcriptionData.length)

    // Stop MediaRecorder if it was created in background script
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop())
    }

    // Tell content script to stop recording
    if (this.currentTabId) {
      this.sendMessageToTab(this.currentTabId, { type: 'stopRecording' })
    }

    this.isRecording = false
    
    // Save final transcription file
    console.log('Saving final transcription file...')
    await this.saveTranscriptionFile()
    
    // Notify content script about state change
    if (this.currentTabId) {
      this.sendMessageToTab(this.currentTabId, { type: 'recordingState', isRecording: false })
    }
    
    // Send message to popup about recording state
    chrome.runtime.sendMessage({ type: 'recordingState', isRecording: false })
    
    // Show notification that recording stopped
    this.showNotification('Recording Stopped', 'Transcription completed. Check your downloads for the transcript file.')
    
    console.log('Auto transcription stopped')
  }

  getRelativeTimestamp(): string {
    if (!this.recordingStartTime) return '00:00:00'
    
    const elapsed = Date.now() - this.recordingStartTime
    const seconds = Math.floor(elapsed / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    
    return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  }

  private async saveTranscriptionFile() {
    console.log('saveTranscriptionFile called, data length:', this.transcriptionData.length)
    
    const content = this.formatTranscription()
    
    // Convert content directly to data URL since URL.createObjectURL is not available in background script
    const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`
    
    const videoTitle = await this.getVideoTitle()
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    const filename = `transcript-${videoTitle}-${timestamp}.txt`

    try {
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false
      })

      console.log(`Saved transcription: ${filename}`)
      
      // Send message to popup about saved file
      chrome.runtime.sendMessage({
        type: 'fileSaved',
        filename: filename
      })
    } catch (error) {
      console.error('Failed to download file:', error)
    }
  }

  private formatTranscription(): string {
    let content = `YouTube Video Transcription\n`
    content += `Generated: ${new Date().toISOString()}\n`
    content += `Total Segments: ${this.transcriptionData.length}\n`
    content += `Session Duration: ${this.getRelativeTimestamp()}\n`
    content += `\n${'='.repeat(60)}\n\n`

    if (this.transcriptionData.length === 0) {
      content += `No transcription data captured.\n`
      content += `This could be due to:\n`
      content += `- Silent or very quiet audio\n`
      content += `- Audio format not supported by Speech-to-Text API\n`
      content += `- Network issues with the transcription service\n`
      content += `- YouTube video without clear speech\n`
      content += `- Audio encoding mismatch (try different browsers)\n`
      return content
    }

    // Show chronological transcript
    content += `--- TRANSCRIPT ---\n\n`
    this.transcriptionData.forEach((entry) => {
      content += `[${entry.timestamp}]: ${entry.text}\n\n`
    })

    return content
  }

  private async getVideoTitle(): Promise<string> {
    try {
      if (this.currentTabId) {
        const tab = await chrome.tabs.get(this.currentTabId)
        if (tab?.title) {
          return tab.title
            .replace(' - YouTube', '')
            .replace(/[^\w\s-]/g, '')
            .slice(0, 50)
        }
      }
      return 'video'
    } catch {
      return 'video'
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.readAsDataURL(blob)
    })
  }
}

// Initialize service
const transcriptionService = new UniversalTranscriptionService()

console.log('Background script loaded and running')

// Log available APIs on startup
console.log('Chrome APIs available:', {
  tabCapture: !!chrome.tabCapture,
  'tabCapture.capture': !!(chrome.tabCapture?.capture),
  downloads: !!chrome.downloads,
  notifications: !!chrome.notifications,
  tabs: !!chrome.tabs
})

// Handle messages from popup
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log('Background received message:', message)
  
  if (message.type === 'test') {
    console.log('Test message received, sending response')
    sendResponse({ success: true, message: 'Background script is working' })
  } else if (message.type === 'getRecordingState') {
    console.log('Getting recording state:', transcriptionService.recording)
    sendResponse({ isRecording: transcriptionService.recording })
  } else if (message.type === 'startRecording') {
    console.log('Starting recording from popup request...')
    
    // First, check if the current active tab is a YouTube video
    chrome.tabs.query({ active: true, currentWindow: true }, async (activeTabs) => {
      if (activeTabs.length > 0) {
        const currentTab = activeTabs[0]
        console.log('Current active tab:', currentTab.id, currentTab.url)
        
        if (currentTab.url?.includes('youtube.com')) {
          console.log('✅ Current tab is YouTube, starting recording on current tab...')
          
          // Start recording on the current tab
          transcriptionService.startRecording(currentTab.id!)
          
          chrome.action.setBadgeText({ text: 'REC', tabId: currentTab.id })
          
          sendResponse({ success: true, isRecording: true, message: 'Recording started on current YouTube tab' })
          return
        } else {
          console.log('Current tab is not YouTube:', currentTab.url)
        }
      }
      
      // If current tab is not YouTube, search for any YouTube tab
      console.log('🔍 Searching for YouTube tabs...')
      chrome.tabs.query({}, (tabs) => {
        const youtubeTabs = tabs.filter(tab => tab.url?.includes('youtube.com'))
        
        if (youtubeTabs.length > 0) {
          const youtubeTab = youtubeTabs[0]
          console.log(`Found ${youtubeTabs.length} YouTube tab(s), using:`, youtubeTab.id, youtubeTab.url)
        
        // Start the actual recording using tabCapture
          transcriptionService.startRecording(youtubeTab.id!)
        
        chrome.action.setBadgeText({ text: 'REC', tabId: youtubeTab.id })
        
          sendResponse({ 
            success: true, 
            isRecording: true, 
            message: `Recording started on YouTube tab: ${youtubeTab.title || 'YouTube'}` 
          })
      } else {
        const error = 'No YouTube tab found. Please open a YouTube video first.'
        console.error(error)
        sendResponse({ success: false, error })
      }
      })
    })
    
    return true // Keep message channel open for async response
  } else if (message.type === 'stopRecording') {
    console.log('Stopping recording from popup request...')
    
    // Call the actual stopRecording method to save the file
    await transcriptionService.stopRecording()
    
    chrome.action.setBadgeText({ text: '' })
    
    sendResponse({ success: true, isRecording: false })
  } else if (message.type === 'contentScriptReady') {
    console.log('Content script is ready on tab:', sender.tab?.id)
    if (sender.tab?.id) {
      transcriptionService.currentTab = sender.tab.id
    }
  } else if (message.type === 'audioChunk') {
    console.log('=== AUDIO CHUNK RECEIVED ===')
    console.log('Received audio chunk from content script:')
    console.log('- Size:', message.size, 'bytes')
    console.log('- Encoding:', message.encoding)
    console.log('- MIME type:', message.mimeType)
    console.log('- Sample rate:', message.sampleRate)
    console.log('- Audio data length:', message.audioData ? message.audioData.length : 'undefined')
    console.log('- Audio data preview:', message.audioData ? message.audioData.substring(0, 100) + '...' : 'undefined')
    
    if (message.encoding === 'WEBM_ORIGINAL' && message.audioData && message.size > 0) {
      // Handle WebM_ORIGINAL format - process with Google API directly
      console.log(`Processing WEBM_ORIGINAL format directly with Google API`)
      try {
        const base64Data = message.audioData.split(',')[1] || message.audioData
        console.log(`Extracted base64 data length: ${base64Data.length} characters`)
        
        const binaryData = atob(base64Data)
        const bytes = new Uint8Array(binaryData.length)
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i)
        }
        const audioBlob = new Blob([bytes], { type: message.mimeType || 'audio/webm;codecs=opus' })
        
        console.log(`Created audio blob: ${audioBlob.size} bytes, type: ${audioBlob.type}`)
        
        // Process with WebM handling
        const timestamp = transcriptionService.getRelativeTimestamp()
        transcriptionService.processWebMChunk(audioBlob, timestamp)
        
      } catch (error) {
        console.error('Failed to process WebM_ORIGINAL audio data:', error)
      }
    } else if ((message.encoding === 'WEBM_OPUS' || message.encoding === 'ORIGINAL') && message.audioData && message.size > 0) {
      // Handle legacy WebM/Opus or original format - try to process with Google API directly
      console.log(`Processing ${message.encoding} format directly with Google API`)
      try {
        const base64Data = message.audioData.split(',')[1] || message.audioData
        const binaryData = atob(base64Data)
        const bytes = new Uint8Array(binaryData.length)
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i)
        }
        const audioBlob = new Blob([bytes], { type: message.mimeType || 'audio/webm;codecs=opus' })
        
        // Process with original WebM handling
        const timestamp = transcriptionService.getRelativeTimestamp()
        transcriptionService.processWebMChunk(audioBlob, timestamp)
        
      } catch (error) {
        console.error('Failed to process WebM audio data:', error)
      }
    } else {
      console.warn('Received unknown or invalid audio chunk format:', {
        encoding: message.encoding,
        hasAudioData: !!message.audioData,
        size: message.size,
        mimeType: message.mimeType
      })
    }
    console.log('=== END AUDIO CHUNK ===')
  } else if (message.type === 'recordingStarted') {
    console.log('Content script confirmed recording started')
    // Update recording state
    transcriptionService.setRecordingState(true)
    chrome.runtime.sendMessage({ type: 'recordingState', isRecording: true })
  } else if (message.type === 'recordingStopped') {
    console.log('Content script confirmed recording stopped')
    chrome.runtime.sendMessage({ type: 'recordingState', isRecording: false })
  } else if (message.type === 'recordingError') {
    console.error('Content script recording error:', message.error)
    transcriptionService.setRecordingState(false)
    chrome.runtime.sendMessage({ type: 'recordingError', error: message.error })
  }
  
  return true
})
