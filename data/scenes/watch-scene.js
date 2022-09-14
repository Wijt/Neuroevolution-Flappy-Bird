class WatchScene extends Scene {
    constructor() {
        super();
        this.superBird;
        this.pipes;
        
        this.gameStarted = false;

        this.nextPipe = null;

        this.returnToMenuButton;
    }

    setupUI() {
        if (this.returnToMenuButton != null) return;

        this.returnToMenuButton = createButton('<');
        let bottomLeftCorner = createVector();
        this.returnToMenuButton.size(30, 30);
        bottomLeftCorner.x = innerWidth/2 - width/2 + 10;
        bottomLeftCorner.y = innerHeight - (innerHeight - height)/2 - 40;
        this.returnToMenuButton.position(bottomLeftCorner.x, bottomLeftCorner.y);
        this.returnToMenuButton.mousePressed(() => {
            this.sceneManager.openScene(MENU_SCENE);
            this.returnToMenuButton.remove(); //to pervent any bug
        });
    }

    start() {
        super.start();
        
        this.setupUI();        

        this.superBird = new AIBird(BIRD_X, 100, NeuralNetwork.deserialize(geniusBirdJson));

        this.pipes = [];

        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
    

        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }
            
        this.gameStarted = true;
    }

    update() {
        super.update();
    
        if (!this.gameStarted) return;

        //If the player is dead, don't update the pipes
        if (!this.superBird.live) return; 
        
        this.pipes.forEach(pipe => {
            pipe.update();
        });

     
        //select next pipe for flappy bird.
        //pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R)
        //this should be the selecting criterion because superBird learn with this. otherwise it is not perform that good
        this.nextPipe = this.pipes.filter(pipe => pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R))[0];

        if (this.nextPipe != null) {
            
            let inputs = [];
            inputs[0] = this.nextPipe.bottomPipe.x1;
            inputs[1] = this.superBird.pos.y;
            inputs[2] = this.superBird.velocity;
            inputs[3] = this.nextPipe.bottomPipe.y1;
            inputs[4] = this.nextPipe.topPipe.y2;
            this.superBird.inputs = inputs;

            this.superBird.update();

            // kill the player if hit a pipe
            let hitted = circleRect(this.superBird, this.nextPipe.topPipe) || circleRect(this.superBird, this.nextPipe.bottomPipe);
            if (hitted) this.superBird.live = false;

            // give the player a point if he passed a pipe
            if (this.superBird.pos.x > this.nextPipe.pos.x && this.nextPipe.hasPoint) {
                this.superBird.score++;
                this.nextPipe.hasPoint = false;
            }
        }
        
        // check if the player hit the ground
        if (this.superBird.pos.y > height - GROUND_HEIGHT) {
            this.superBird.live = false;
        }
    }

    draw() {      
        background(color(BG_COLOR));

        this.pipes.forEach(pipe => {
            pipe.show();
        });
        
        //Shows the nextPipe different
        //this.nextPipe.debugShow();

        //player should be drawn after the pipes so it's not hidden by them when dieing
        this.superBird.show(); 
        
        push(); //Ground drawing
            noStroke();
            fill(color(GROUND_COLOR));
            rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push(); //Score drawing
            textAlign(CENTER);
            fill(255);
            textSize(60);
            text(this.superBird.score, width/2, 60);
        pop();
        
        if (!this.superBird.live) {
            push(); //dead panel background
                fill(0, 0, 0, 255 * 0.70);
                rect(0, 0, width, height);
                this.start();
            pop();
        }
    }
}