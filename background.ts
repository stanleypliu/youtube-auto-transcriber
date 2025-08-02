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
  private transcriptionData: TranscriptionEntry[] = []
  private sessionStartTime: number | null = null
  private chunkCount = 0
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
      
      // Since tabCapture.capture is not available, we'll use the content script approach
      console.log('tabCapture.capture not available, using content script approach')
      
      this.sessionStartTime = Date.now()
      this.isRecording = true
      this.transcriptionData = []
      this.chunkCount = 0
      
      // Notify content script to start recording
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
        iconUrl: 'icon.png', // Remove 'assets/' path as it might not exist
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
        }
      })
    } catch (error) {
      console.log('Error sending message to tab:', error)
    }
  }

  async processAudioChunkWithGoogle(audioBlob: Blob) {
    const timestamp = this.getRelativeTimestamp()
    this.chunkCount++

    console.log(`Processing chunk ${this.chunkCount} at ${timestamp}, size: ${audioBlob.size} bytes`)

    try {
      const apiKey = await storage.get("google_api_key")
      if (!apiKey) {
        console.error('No API key available')
        return
      }
      
      // Convert blob to base64 for Google API
      const audioBase64 = await this.blobToBase64(audioBlob)
      
      // Google Cloud Speech-to-Text REST API call
      const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            encoding: 'WEBM_OPUS',
            sampleRateHertz: 48000,
            languageCode: 'en-US', // Start with English for better reliability
            enableAutomaticPunctuation: true,
            model: 'video',
            useEnhanced: true
          },
          audio: {
            content: audioBase64.split(',')[1] // Remove data URL prefix
          }
        })
      })

      if (response.ok) {
        const result = await response.json()
        console.log('Google Speech API response:', result)
        
        if (result.results && result.results.length > 0) {
          const transcription = result.results[0].alternatives[0].transcript
          const confidence = result.results[0].alternatives[0].confidence || 0
          
          const entry: TranscriptionEntry = {
            timestamp,
            text: transcription.trim(),
            language: 'en-US',
            chunkNumber: this.chunkCount
          }
          
          this.transcriptionData.push(entry)
          console.log(`[${timestamp}] (confidence: ${confidence.toFixed(2)}): ${transcription}`)
          
          // Send message to popup about processed chunk
          chrome.runtime.sendMessage({
            type: 'chunkProcessed',
            chunkNumber: this.chunkCount,
            language: 'en-US',
            text: transcription
          })
          
          // Auto-save every 10 chunks to avoid losing data
          if (this.chunkCount % 10 === 0) {
            await this.saveTranscriptionFile()
          }
        } else {
          console.log(`Chunk ${this.chunkCount}: No transcription results (silent audio or unclear speech)`)
        }
      } else {
        const errorText = await response.text()
        console.error('Google Speech API error:', response.status, errorText)
        
        if (response.status === 429) {
          this.showNotification('Rate Limit Reached', 'Google API rate limit reached. Try again later.')
        } else if (response.status === 403) {
          this.showNotification('API Key Error', 'API key is invalid or lacks permissions.')
        } else if (response.status === 400) {
          console.log('Bad request - possibly unsupported audio format or empty audio')
        }
      }
      
    } catch (error) {
      console.error('Error processing audio chunk:', error)
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

  private getRelativeTimestamp(): string {
    if (!this.sessionStartTime) return '00:00:00'
    
    const elapsed = Date.now() - this.sessionStartTime
    const seconds = Math.floor(elapsed / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    
    return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  }

  private async saveTranscriptionFile() {
    console.log('saveTranscriptionFile called, data length:', this.transcriptionData.length)
    
    const content = this.formatTranscription()
    const blob = new Blob([content], { type: 'text/plain; charset=utf-8' })
    const url = URL.createObjectURL(blob)
    
    const videoTitle = await this.getVideoTitle()
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    const filename = `transcript-${videoTitle}-${timestamp}.txt`

    try {
      chrome.downloads.download({
        url: url,
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
      content += `- Audio not being captured properly\n`
      content += `- Network issues with the transcription service\n`
      content += `- YouTube video without audio\n`
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
    
    // Find YouTube tab
    chrome.tabs.query({}, (tabs) => {
      const youtubeTab = tabs.find(tab => tab.url?.includes('youtube.com'))
      
      if (youtubeTab && youtubeTab.id) {
        console.log('Found YouTube tab:', youtubeTab.id, youtubeTab.url)
        
        // Start the actual recording using tabCapture
        transcriptionService.startRecording(youtubeTab.id)
        
        chrome.action.setBadgeText({ text: 'REC', tabId: youtubeTab.id })
        
        sendResponse({ success: true, isRecording: true })
      } else {
        const error = 'No YouTube tab found. Please open a YouTube video first.'
        console.error(error)
        sendResponse({ success: false, error })
      }
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
    console.log('Received audio chunk from content script, size:', message.size)
    if (message.audioData && message.size > 0) {
      // Convert base64 back to blob for processing
      try {
        const base64Data = message.audioData.split(',')[1] // Remove data URL prefix
        const binaryData = atob(base64Data)
        const bytes = new Uint8Array(binaryData.length)
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i)
        }
        const audioBlob = new Blob([bytes], { type: message.mimeType || 'audio/webm' })
        
        transcriptionService.processAudioChunkWithGoogle(audioBlob)
      } catch (error) {
        console.error('Failed to reconstruct audio blob:', error)
      }
    } else {
      console.warn('Received invalid audio chunk data')
    }
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
